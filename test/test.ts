import * as should from 'should';
import { Worker } from '../lib/worker';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import * as sleep from 'sleep';
import * as fs from 'fs';
import { startGrpcMockServer, bucketPolicySetRQ, stopGrpcMockServer, permitCreateObjRule, denyCreateObjRule } from './utils';

const Events = kafkaClient.Events;

let cfg: any;
let logger;
let client;
let worker: Worker;
// For event listeners
let events;
let oStorage;

const options = {
  encoding: 'gzip',
  content_type: "application/pdf",
  content_language: "en-UK",
  content_disposition: "inline",
  length: 1,
  version: "v1.0",
  md5: 'd131dd02c5e6eec4',
  tags: [
    {
      id: 'id_1',
      value: 'value_1'
    },
    {
      id: 'id_2',
      value: 'value_2'
    }
  ]
};

let meta = {
  modified_by: 'SYSTEM',
  owner: [{
    id: 'urn:restorecommerce:acs:names:ownerIndicatoryEntity',
    value: 'urn:restorecommerce:acs:model:organization.Organization'
  },
  {
    id: 'urn:restorecommerce:acs:names:ownerInstance',
    value: 'orgC'
  }]
};

async function start(): Promise<void> {
  cfg = createServiceConfig(process.cwd() + '/test');
  worker = new Worker(cfg);
  await worker.start();
}

async function stop(): Promise<void> {
  await worker.stop();
}

// returns a gRPC service
async function connect(clientCfg: string, resourceName: string): Promise<any> {
  logger = worker.logger;

  events = new Events(cfg.get('events:kafka'), logger);
  await (events.start());

  client = new grpcClient.Client(cfg.get(clientCfg), logger);
  const service = await client.connect();
  return service;
}

describe('testing ostorage-srv with ACS enabled', () => {
  let mockServer: any;
  before(async function startServer(): Promise<void> {
    // ACS is enabled in config by default
    await start();
  });

  after(async function stopServer(): Promise<void> {
    await stop();
    stopGrpcMockServer(mockServer, logger);
  });
  let subject;
  // mainOrg -> orgA -> orgB -> orgC
  const acsSubject = {
    id: 'admin_user_id',
    scope: 'orgC',
    role_associations: [
      {
        role: 'admin-r-id',
        attributes: [{
          id: 'urn:restorecommerce:acs:names:roleScopingEntity',
          value: 'urn:restorecommerce:acs:model:organization.Organization'
        },
        {
          id: 'urn:restorecommerce:acs:names:roleScopingInstance',
          value: 'mainOrg'
        }]
      }
    ],
    hierarchical_scopes: [
      {
        id: 'mainOrg',
        role: 'admin-r-id',
        children: [{
          id: 'orgA',
          children: [{
            id: 'orgB',
            children: [{
              id: 'orgC'
            }]
          }]
        }]
      }
    ]
  };

  describe('Object Storage with ACS enabled', () => {
    it('With valid subject scope should store the data to storage server using request streaming', async () => {
      // strat acs mock service
      await connect('grpc-client:service-ostorage', '');
      // PERMIT mock
      bucketPolicySetRQ.policy_sets[0].policies[0].rules = [permitCreateObjRule];
      bucketPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: bucketPolicySetRQ },
      { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);
      let response, putResponse;
      subject = acsSubject;
      // create streaming client request
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const put = client.makeEndpoint('put', clientConfig.publisher.instances[0]);
      const call = await put();
      const readStream = fs.createReadStream('./test/cfg/config.json');
      readStream.on('data', async (chunk) => {
        const data = {
          bucket: 'test',
          key: 'config_acs_enabled.json',
          object: chunk,
          meta,
          options,
          subject
        };
        await call.write(data);
      });

      response = await new Promise(async (resolve, reject) => {
        readStream.on('end', async () => {
          putResponse = await call.end((err, data) => { });
          response = await new Promise((resolve, reject) => {
            putResponse((err, data) => {
              resolve(data);
            });
          });
          resolve(response);
          return response;
        });
      });
      should(response.error).null;
      should.exist(response.bucket);
      should.exist(response.key);
      should.exist(response.url);
      response.key.should.equal('config_acs_enabled.json');
      response.bucket.should.equal('test');
      response.url.should.equal('//test/config_acs_enabled.json');
    });
    it('With valid subject scope should be able to read the object', async () => {
      // create streaming client request
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
      const call = await get({
        key: 'config_acs_enabled.json',
        bucket: 'test',
        subject
      });
      let result;
      result = await call.read();
      result = await new Promise((resolve, reject) => {
        result((err, response) => {
          if (err) {
            reject(err);
          }
          resolve(response);
        });
      });
      should.exist(result);
      should.exist(result.key);
      should.exist(result.url);
      should.exist(result.object);
      result.url.should.equal('//test/config_acs_enabled.json');
      meta.owner.should.deepEqual(result.meta.owner);
      sleep.sleep(3);
    });
    it('With valid subject scope should be able to list the object', async () => {
      oStorage = await connect('grpc-client:service-ostorage', '');
      let result = await oStorage.list({ subject });
      should.exist(result.data);
      should.exist(result.data.object_data);
      result.data.object_data.length.should.equal(1);
    });
    it('With invalid subject scope should throw an error when storing object', async () => {
      // stop and restart acs mock service for DENY
      await stopGrpcMockServer(mockServer, logger);
      // DENY mock
      bucketPolicySetRQ.policy_sets[0].policies[0].rules = [denyCreateObjRule];
      bucketPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: bucketPolicySetRQ },
      { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'DENY' } }], logger);
      let response, putResponse;
      subject = acsSubject;
      subject.scope = 'orgD'; // set scope to invalid value which does not exist in user HR scope
      subject.id = 'invalid_user_scope_id'
      // create streaming client request
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const put = client.makeEndpoint('put', clientConfig.publisher.instances[0]);
      const call = await put();
      const readStream = fs.createReadStream('./test/cfg/config.json');
      readStream.on('data', async (chunk) => {
        const data = {
          bucket: 'test',
          key: 'config_invalid_scope',
          object: chunk,
          meta,
          options,
          subject
        };
        await call.write(data);
      });

      response = await new Promise(async (resolve, reject) => {
        readStream.on('end', async () => {
          putResponse = await call.end((err, data) => { });
          response = await new Promise((resolve, reject) => {
            putResponse((err, data) => {
              const errResponse = {
                error: {
                  code: err.code,
                  message: err.details || err.message
                }
              };
              resolve(errResponse);
            });
          });
          resolve(response);
          return response;
        });
      });
      should.exist(response.error);
      response.error.message.should.equal('Access not allowed for request with subject:invalid_user_scope_id, resource:test, action:CREATE, target_scope:orgD; the response was DENY');
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when reading object', async () => {
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_1';
      const call = await get({
        key: 'config_acs_enabled.json',
        bucket: 'test',
        subject
      });
      let streamResponse = true;
      let streamData = {
        key: '', object: {}, url: '', error: { code: null, message: null }
      };
      let streamBuffer = [];
      let result;
      try {
        while (streamResponse) {
          result = await call.read();
          result = await new Promise((resolve, reject) => {
            result((err, response) => {
              if (err) {
                reject(err);
              }
              resolve(response);
            });
          });
          streamData.key = result.key;
          streamData.url = result.url;
          if (result.error) {
            streamData.error = result.error;
          }
          streamBuffer.push(result.object);
        }
      } catch (err) {
        should.exist(err.details);
        err.details.should.equal('Access not allowed for request with subject:invalid_subject_id_1, resource:test, action:READ, target_scope:orgC; the response was DENY');
      }
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when listing object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_2';
      let result = await oStorage.list({
        bucket: 'test',
        subject
      });
      should.exist(result.error);
      result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:invalid_subject_id_2, resource:test, action:READ, target_scope:orgD; the response was DENY');
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when deleting object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_3';
      let result = await oStorage.delete({
        bucket: 'test',
        key: 'config_acs_enabled.json',
        subject
      });
      should.exist(result.error);
      result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:invalid_subject_id_3, resource:test, action:DELETE, target_scope:orgD; the response was DENY');
      sleep.sleep(3);
    });
    it('With invalid scope should throw an error when replacing the object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_4';
      // create streaming client request
      const data = {
        items: {
          bucket: 'test',
          copySource: 'test/config_acs_enabled.json',
          key: 'config_copy.json',
          meta: meta,
          options: {
            encoding: 'gzip',
            content_type: 'text/html',
            content_language: 'de-DE',
            content_disposition: 'form-data',
            tags: [
              {
                id: 'id_1',
                value: 'value_1'
              }
            ]
          }
        },
        subject // invalid subject scope containg 'orgD'
      };
      const result = await oStorage.copy(data);
      should.exist(result.error);
      should.exist(result.error.details);
      result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:invalid_subject_id_4, resource:test, action:READ, target_scope:orgC; the response was DENY');
      sleep.sleep(3);
    });
    it('With valid scope should replace the object', async () => {
      subject.id = 'admin_user_id';
      subject.scope = 'orgC'; // setting valid subject scope
      await stopGrpcMockServer(mockServer, logger);
      // PERMIT mock
      bucketPolicySetRQ.policy_sets[0].policies[0].rules = [permitCreateObjRule];
      bucketPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: bucketPolicySetRQ },
      { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);
      const data = {
        items: {
          bucket: 'test',
          copySource: 'test/config_acs_enabled.json',
          key: 'config_acs_enabled.json',
          meta: meta,
          options: {
            encoding: 'gzip',
            content_type: 'text/html',
            content_language: 'de-DE',
            content_disposition: 'form-data',
            tags: [
              {
                id: 'id_1',
                value: 'value_1'
              }
            ]
          }
        },
        subject // invalid subject scope containg 'orgD'
      };
      const result = await oStorage.copy(data);
      should(result.error).null;
      should.exist(result.data);
      should.exist(result.data.response);

      let response = result.data.response;
      should.exist(response[0].bucket);
      should.exist(response[0].copySource);
      should.exist(response[0].key);
      should.exist(response[0].meta.owner[1].value);
      should.exist(response[0].options.encoding);
      should.exist(response[0].options.tags[0].id);

      response[0].bucket.should.equal('test');
      response[0].copySource.should.equal('test/config_acs_enabled.json');
      response[0].key.should.equal('config_acs_enabled.json');
      response[0].meta.owner.should.deepEqual(meta.owner);
      response[0].options.encoding.should.equal('gzip');
      response[0].options.tags[0].id.should.equal('id_1');
      sleep.sleep(3);
    });
    it('With valid subject scope should delete the object', async () => {
      let result = await oStorage.delete({
        bucket: 'test',
        key: 'config_acs_enabled.json',
        subject
      });
      should(result.error).null;
      should(result.data).empty;
      await stopGrpcMockServer(mockServer, logger);
    });
  });
});

describe('testing ostorage-srv with ACS disabled', () => {
  before(async function startServer(): Promise<void> {
    await start();
    // Disable ACS
    worker.oss.disableAC();
  });

  after(async function stopServer(): Promise<void> {
    await stop();
  });

  describe('Object Storage with ACS disabled', () => {
    it('Should be empty initially', async () => {
      oStorage = await connect('grpc-client:service-ostorage', '');
      let result = await oStorage.list();
      should(result.data.object_data).empty;
    });

    it('Should return an error if an invalid object name is used', async () => {
      // create streaming client request
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const put = client.makeEndpoint('put', clientConfig.publisher.instances[0]);
      const call = await put();
      const readStream = fs.createReadStream('./test/cfg/config.json');

      let streamRequest;
      readStream.on('data', async (chunk) => {
        const data = {
          bucket: 'test',
          key: 'config{}.json',
          object: chunk,
          meta,
          options
        };
        await call.write(data);
      });


      streamRequest = await call.end((err, data) => {
        if (err) {
          return err;
        } else {
          return data;
        }
      });

      await new Promise(async (resolve, reject) => {
        readStream.on('end', async () => {
          const streamingResponse = await new Promise((resolve, reject) => {
            streamRequest((err, data) => {
              if (err) {
                should.exist(err.message);
                err.details.should.equal('Invalid Object name config{}.json');
                resolve(err);
              } else {
                resolve(data);
              }
            });
          });
          resolve(streamingResponse);
          return streamingResponse;
        });
      });
      sleep.sleep(3);
    });

    it('Should store the data to storage server using request streaming', async () => {
      let response;
      // create streaming client request
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const put = client.makeEndpoint('put', clientConfig.publisher.instances[0]);
      const call = await put();
      const readStream = fs.createReadStream('./test/cfg/config.json');
      readStream.on('data', async (chunk) => {
        const data = {
          bucket: 'test',
          key: 'config.json',
          object: chunk,
          meta,
          options
        };
        await call.write(data);
      });

      response = await new Promise(async (resolve, reject) => {
        readStream.on('end', async () => {
          response = await call.end((err, data) => { });
          response = await new Promise((resolve, reject) => {
            response((err, data) => {
              resolve(data);
            });
          });
          resolve(response);
          return response;
        });
      });
      should(response.error).null;
      should.exist(response.bucket);
      should.exist(response.key);
      should.exist(response.url);
      should.exist(response.meta);
      should.exist(response.tags);
      should.exist(response.length);
      response.key.should.equal('config.json');
      response.bucket.should.equal('test');
      response.url.should.equal('//test/config.json');

      // check meta
      response.meta.owner.should.deepEqual(meta.owner);

      // check tags
      response.tags[0].id.should.equal('id_1');
      response.tags[0].value.should.equal('value_1');
      response.tags[1].id.should.equal('id_2');
      response.tags[1].value.should.equal('value_2');

      // check length
      response.length.should.equal(9382);

      sleep.sleep(3);
    });

    it('should get metadata of the Object', async () => {
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
      const call = await get({
        key: 'config.json',
        bucket: 'test'
      });
      let result;
      result = await call.read();
      result = await new Promise((resolve, reject) => {
        result((err, response) => {
          if (err) {
            reject(err);
          }
          resolve(response);
        });
      });
      should.exist(result);
      should.exist(result.key);
      should.exist(result.url);
      should.exist(result.object);
      meta.owner.should.deepEqual(result.meta.owner);
      sleep.sleep(3);
    });

    it('should get the Object with response streaming', async () => {
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
      const call = await get({
        key: 'config.json',
        bucket: 'test'
      });
      let streamResponse = true;
      let streamData = {
        key: '', object: {}, url: '', error: { code: null, message: null }
      };
      let streamBuffer = [];
      let result;
      try {
        while (streamResponse) {
          result = await call.read();
          result = await new Promise((resolve, reject) => {
            result((err, response) => {
              if (err) {
                reject(err);
              }
              resolve(response);
            });
          });
          streamData.key = result.key;
          streamData.url = result.url;
          if (result.error) {
            streamData.error = result.error;
          }
          streamBuffer.push(result.object);
        }
      } catch (err) {
        streamResponse = false;
        if (err.message === 'stream end') {
          logger.info('readable stream ended.');
        }
      }
      streamData.object = Buffer.concat(streamBuffer);
      should.exist(streamData);
      should.exist(streamData.object);
      should.exist(streamData.key);
      should.exist(streamData.url);
      streamData.key.should.equal('config.json');
      sleep.sleep(3);
    });

    it('should list the Object', async () => {
      let result = await oStorage.list({
        bucket: 'test'
      });
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.object_data);
      should(result.data.object_data).length(1);
      sleep.sleep(3);
    });

    it('should throw an error for invalid bucket request', async () => {
      let result = await oStorage.list({
        bucket: 'invalid_bucket'
      });
      should.exist(result);
      should.exist(result.error);
      should.exist(result.error.details);
      result.error.details.should.equal('13 INTERNAL: The specified bucket does not exist');
      sleep.sleep(3);
    });

    it('Should replace the object', async () => {
      // create streaming client request
      const data = {
        items: {
          bucket: 'test',
          copySource: 'test/config.json',
          key: 'config.json',
          meta: meta,
          options: {
            encoding: 'gzip',
            content_type: 'text/html',
            content_language: 'de-DE',
            content_disposition: 'form-data',
            tags: [
              {
                id: 'id_1',
                value: 'value_1'
              }
            ]
          }
        }
      };

      let result = await oStorage.copy(data);
      should(result.error).null;
      should.exist(result.data);
      should.exist(result.data.response);

      let response = result.data.response;
      should.exist(response[0].bucket);
      should.exist(response[0].copySource);
      should.exist(response[0].key);
      should.exist(response[0].meta.owner[1].value);
      should.exist(response[0].options.encoding);
      should.exist(response[0].options.tags[0].id);

      response[0].bucket.should.equal('test');
      response[0].copySource.should.equal('test/config.json');
      response[0].key.should.equal('config.json');
      response[0].meta.owner.should.deepEqual(meta.owner);
      response[0].options.encoding.should.equal('gzip');
      response[0].options.tags[0].id.should.equal('id_1');
      sleep.sleep(3);
    });

    it('should delete the object', async () => {
      let result = await oStorage.delete({
        bucket: 'test',
        key: 'config.json'
      });
      should(result.error).null;
      should(result.data).empty;
    });

  });
});