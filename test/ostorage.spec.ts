import * as should from 'should';
import { Worker } from '../lib/worker';
import { GrpcClient } from '@restorecommerce/grpc-client';
import { Events, Topic } from '@restorecommerce/kafka-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import * as sleep from 'sleep';
import * as fs from 'fs';
import { startGrpcMockServer, bucketPolicySetRQ, stopGrpcMockServer, permitCreateObjRule, denyCreateObjRule } from './utils';
import { unmarshallProtobufAny } from "../lib/utils";
import { from, of } from 'rxjs';
import { Transform } from 'stream';
import * as _ from 'lodash';

let cfg: any;
let logger;
let client;
let worker: Worker;
// For event listeners
let events: Events;
let topic: Topic;
let ostorageService: any;

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
  logger = worker.logger;
  events = new Events({
    ...cfg.get('events:kafka'),
    groupId: 'restore-ostorage-srv-test-runner',
    kafka: {
      ...cfg.get('events:kafka:kafka'),
    }
  }, logger);
  await (events.start());
}

async function stop(): Promise<void> {
  await worker.stop();
}

// returns a gRPC service
async function getOstorageService(clientCfg: any): Promise<any> {
  logger = worker.logger;
  client = new GrpcClient(clientCfg, logger);
  return client.ostorage;
}

describe('testing ostorage-srv with ACS enabled', () => {
  let mockServer: any;
  before(async function startServer(): Promise<void> {
    // ACS is enabled in config by default
    await start();
    ostorageService = await getOstorageService(cfg.get('client:ostorage'));
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
      // PERMIT mock
      bucketPolicySetRQ.policy_sets[0].policies[0].rules = [permitCreateObjRule];
      bucketPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: bucketPolicySetRQ },
      { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);
      subject = acsSubject;
      const readStream = fs.createReadStream('./test/cfg/testObject.json');

      const transformBuffObj = () => {
        return new Transform({
          objectMode: true,
          transform: (chunk, _, done) => {
            // object buffer
            const data = {
              bucket: 'test',
              key: 'config_acs_enabled.json',
              object: chunk,
              meta,
              options,
              subject
            };
            done(null, data);
          }
        });
      };
      const putResponse = await ostorageService.put(readStream.pipe(transformBuffObj()));
      should.exist(putResponse.response.payload);
      putResponse.response.payload.key.should.equal('config_acs_enabled.json');
      putResponse.response.payload.bucket.should.equal('test');
      putResponse.response.payload.url.should.equal('//test/config_acs_enabled.json');
      putResponse.response.status.code.should.equal(200);
      putResponse.response.status.message.should.equal('success');
      putResponse.operation_status.code.should.equal(200);
      putResponse.operation_status.message.should.equal('success');
    });
    it('With valid subject scope should be able to read the object', async () => {
      const call = await ostorageService.get({
        key: 'config_acs_enabled.json',
        bucket: 'test',
        subject
      });
      call.on('data', (data) => {
        if (data?.response?.payload) {
          should.exist(data.response.payload.key);
          data.response.payload.key.should.equal('config_acs_enabled.json');
          should.exist(data.response.payload.bucket);
          data.response.payload.bucket.should.equal('test');
          should.exist(data.response.payload.url);
          data.response.payload.url.should.equal('//test/config_acs_enabled.json');
          should.exist(data.response.payload.object);
          const objectValue = JSON.parse(data.response.payload.object.toString()).testKey;
          should.exist(objectValue);
          objectValue.should.equal('testValue');
        } else {
          // emitted on end event with no payload
          should.exist(data.operation_status);
          data.operation_status.code.should.equal(200);
          data.operation_status.message.should.equal('success');
        }
      });

      await new Promise((resolve, reject) => {
        call.on('end', () => {
          resolve(0);
        });
      });
      sleep.sleep(3);
    });
    it('With valid subject scope should be able to list the object', async () => {
      let result = await ostorageService.list({ subject });
      should.exist(result.response);
      result.response.length.should.equal(1);
    });
    it('With invalid subject scope should throw an error when storing object', async () => {
      // stop and restart acs mock service for DENY
      await stopGrpcMockServer(mockServer, logger);
      // DENY mock
      bucketPolicySetRQ.policy_sets[0].policies[0].rules = [denyCreateObjRule];
      bucketPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: bucketPolicySetRQ },
      { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'DENY' } }], logger);
      subject = acsSubject;
      subject.scope = 'orgD'; // set scope to invalid value which does not exist in user HR scope
      subject.id = 'invalid_user_scope_id';
      const readStream = fs.createReadStream('./test/cfg/testObject.json');

      const transformBuffObj = () => {
        return new Transform({
          objectMode: true,
          transform: (chunk, _, done) => {
            // object buffer
            const data = {
              bucket: 'test',
              key: 'config_invalid_scope',
              object: chunk,
              meta,
              options,
              subject
            };
            done(null, data);
          }
        });
      };

      const putResponse = await ostorageService.put(readStream.pipe(transformBuffObj()));
      should.not.exist(putResponse.response.payload);
      should.exist(putResponse.response.status);
      putResponse.response.status.id.should.equal('config_invalid_scope');
      putResponse.response.status.code.should.equal(403);
      putResponse.response.status.message.should.equal('Access not allowed for request with subject:invalid_user_scope_id, resource:test, action:CREATE, target_scope:orgD; the response was DENY')
      should.exist(putResponse.operation_status);
      putResponse.operation_status.code.should.equal(200);
      putResponse.operation_status.message.should.equal('success');
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when reading object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_1';
      const call = await ostorageService.get({
        key: 'config_acs_enabled.json',
        bucket: 'test',
        subject
      });
      call.on('data', (data) => {
        should.not.exist(data.response.payload);
        should.exist(data.response.status);
        data.response.status.id.should.equal('config_acs_enabled.json');
        data.response.status.code.should.equal(403);
        data.response.status.message.should.equal('Access not allowed for request with subject:invalid_subject_id_1, resource:test, action:READ, target_scope:orgC; the response was DENY');
      });

      await new Promise((resolve, reject) => {
        call.on('end', () => {
          resolve(0);
        });
      });
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when listing object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_2';
      let result = await ostorageService.list({
        bucket: 'test',
        subject
      });
      should(result.response).empty;
      result.operation_status.code.should.equal(403);
      result.operation_status.message.should.equal('Access not allowed for request with subject:invalid_subject_id_2, resource:test, action:READ, target_scope:orgD; the response was DENY');
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when deleting object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_3';
      let result = await ostorageService.delete({
        bucket: 'test',
        key: 'config_acs_enabled.json',
        subject
      });
      should.exist(result.status);
      result.status[0].id.should.equal('config_acs_enabled.json');
      result.status[0].code.should.equal(403);
      result.status[0].message.should.equal('Access not allowed for request with subject:invalid_subject_id_3, resource:test, action:DELETE, target_scope:orgD; the response was DENY');
      sleep.sleep(3);
    });
    it('With invalid scope should result in an error when replacing the object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_4';
      // create streaming client request
      const data = {
        items: [{
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
        }],
        subject // invalid subject scope containg 'orgD'
      };
      const result = await ostorageService.copy(data);

      should.exist(result.response);
      result.response[0].status.id.should.equal('/config_acs_enabled.json');
      result.response[0].status.code.should.equal(403);
      result.response[0].status.message.should.equal('Access not allowed for request with subject:invalid_subject_id_4, resource:test, action:READ, target_scope:orgC; the response was DENY');
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
        items: [{
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
        }],
        subject // invalid subject scope containg 'orgD'
      };
      const result = await ostorageService.copy(data);
      console.log('Copy Response is....', JSON.stringify(result));
      should.exist(result.response);

      let payload = result.response[0].payload;
      should.exist(payload.bucket);
      should.exist(payload.copySource);
      should.exist(payload.key);
      should.exist(payload.meta.owner[1].value);
      should.exist(payload.options.encoding);
      should.exist(payload.options.tags[0].id);

      payload.bucket.should.equal('test');
      payload.copySource.should.equal('test/config_acs_enabled.json');
      payload.key.should.equal('config_acs_enabled.json');
      payload.meta.owner.should.deepEqual(meta.owner);
      payload.options.encoding.should.equal('gzip');
      payload.options.tags[0].id.should.equal('id_1');
      sleep.sleep(3);
    });
    it('With valid subject scope should delete the object', async () => {
      let result = await ostorageService.delete({
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
    ostorageService = await getOstorageService(cfg.get('client:ostorage'));
  });

  after(async function stopServer(): Promise<void> {
    await stop();
  });

  describe('Object Storage with ACS disabled', () => {
    it('Should be empty initially', async () => {
      let result = await ostorageService.list();
      should(result.data.object_data).empty;
    });

    it('Should return an error if an invalid object name is used when storing object', async () => {
      const call = await ostorageService.put();
      const readStream = fs.createReadStream('./test/cfg/testObject.json');
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

      await new Promise(async (resolve, reject) => {
        readStream.on('end', async () => {
          let streamingRequest = await call.end();
          const streamingResponse = await new Promise((resolve, reject) => {
            streamingRequest((err, data) => {
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

    it('Should store the data to storage server using request streaming and' +
      ' validate objectUploaded event once object is stored', async () => {
        let response;
        const call = await ostorageService.put();

        // Create an event listener for the "objectUploaded" event and when an
        // object is uploaded, consume the event and validate the fields being sent.
        const listener = function (msg: any, context: any, config: any, eventName: string): void {
          if (eventName == 'objectUploaded') {
            const key = msg.key;
            const bucket = msg.bucket;
            const metadata = JSON.stringify(unmarshallProtobufAny(msg.metadata));

            let responseMetadata = JSON.stringify(
              {
                "meta": {
                  "created": 0,
                  "modified": 0,
                  "modified_by": "SYSTEM",
                  "owner": [
                    {
                      "id": "urn:restorecommerce:acs:names:ownerIndicatoryEntity",
                      "value": "urn:restorecommerce:acs:model:organization.Organization",
                      "attribute": []
                    },
                    {
                      "id": "urn:restorecommerce:acs:names:ownerInstance",
                      "value": "orgC",
                      "attribute": []
                    }
                  ],
                  "acl": []
                },
                "data": {},
                "subject": {},
                "key": "config.json"
              });
            should.exist(key);
            should.exist(bucket);
            should.exist(metadata);

            key.should.equal('config.json');
            bucket.should.equal('test');
            metadata.should.equal(responseMetadata);
          }
        };
        topic = await events.topic('io.restorecommerce.ostorage');
        topic.on('objectUploaded', listener);

        const readStream = fs.createReadStream('./test/cfg/testObject.json');
        readStream.on('data', async (chunk) => {
          const data = {
            bucket: 'test',
            key: 'config.json',
            object: chunk,
            meta,
            options,
            subject: { scope: 'orgC' }
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
        response.length.should.equal(29);

        sleep.sleep(3);
      });

    it('should get metadata of the Object', async () => {
      const call = await ostorageService.get({
        key: 'config.json',
        bucket: 'test'
      });

      const grpcRespStream = await call.getResponseStream();
      grpcRespStream.on('data', (data) => {
        should.exist(data);
        should.exist(data.key);
        should.exist(data.url);
        should.exist(data.object);
        meta.owner.should.deepEqual(data.meta.owner);
      });
      sleep.sleep(3);
    });

    it('should get the Object with response streaming  and validate' +
      ' objectDownloaded event once object is downloaded', async () => {
        // Create an event listener for the "objectUploaded" event and when an
        // object is uploaded, consume the event and validate the fields being sent.
        const listener = function (msg: any, context: any, config: any, eventName: string): void {
          if (eventName == 'objectDownloadRequested') {
            // what we receive
            const key = msg.key;
            const bucket = msg.bucket;
            const metadata = unmarshallProtobufAny(msg.metadata);

            // what we expect
            const responseMetadata = {
              optionsObj: {
                encoding: "gzip",
                content_type: "application/pdf",
                content_language: "en-UK",
                content_disposition: "inline",
                length: 29
              },
              metaObj: {
                created: 0,
                modified: 0,
                modified_by: 'SYSTEM',
                owner: [
                  {
                    id: "urn:restorecommerce:acs:names:ownerIndicatoryEntity",
                    value: "urn:restorecommerce:acs:model:organization.Organization",
                    attribute: []
                  },
                  {
                    id: "urn:restorecommerce:acs:names:ownerInstance",
                    value: "orgC",
                    attribute: []
                  }
                ],
                acl: []
              },
              data: {},
              meta_subject: {}
            }

            should.exist(key);
            should.exist(bucket);
            should.exist(metadata);

            key.should.equal('config.json');
            bucket.should.equal('test');
            metadata.optionsObj.encoding.should.equal(responseMetadata.optionsObj.encoding);
            metadata.optionsObj.content_type.should.equal(responseMetadata.optionsObj.content_type);
            metadata.optionsObj.content_language.should.equal(responseMetadata.optionsObj.content_language);
            metadata.optionsObj.content_disposition.should.equal(responseMetadata.optionsObj.content_disposition);
            metadata.optionsObj.length.should.equal(responseMetadata.optionsObj.length);
            metadata.metaObj.should.deepEqual(responseMetadata.metaObj);
          }
        };

        topic = await events.topic('io.restorecommerce.ostorage');
        topic.on('objectDownloadRequested', listener);

        const call = await ostorageService.get({
          key: 'config.json',
          bucket: 'test'
        });
        let streamData = {
          key: '', object: {}, url: '', error: { code: null, message: null }
        };
        let streamBuffer = [];
        try {
          const grpcRespStream = await call.getResponseStream();
          grpcRespStream.on('data', (data) => {
            streamData.key = data.key;
            streamData.url = data.url;
            streamBuffer.push(data.object);
            should.exist(streamData);
            should.exist(streamData.object);
            should.exist(streamData.key);
            should.exist(streamData.url);
            streamData.key.should.equal('config.json');
          });
        } catch (err) {
          if (err.message === 'stream end') {
            logger.info('readable stream ended.');
          }
        }
        streamData.object = Buffer.concat(streamBuffer);
        sleep.sleep(3);
      });

    it('should list the Object', async () => {
      let result = await ostorageService.list({
        bucket: 'test'
      });
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.object_data);
      should(result.data.object_data).length(1);
      sleep.sleep(3);
    });

    it('should throw an error for invalid bucket request', async () => {
      let result = await ostorageService.list({
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

      let result = await ostorageService.copy(data);
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
      let result = await ostorageService.delete({
        bucket: 'test',
        key: 'config.json'
      });
      should(result.error).null;
      should(result.data).empty;
    });

  });
});
