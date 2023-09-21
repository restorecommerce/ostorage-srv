import should from 'should';
import { Worker } from '../lib/worker';
import { createClient, createChannel } from '@restorecommerce/grpc-client';
import { Events, Topic } from '@restorecommerce/kafka-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import * as sleep from 'sleep';
import * as fs from 'fs';
import { bucketPolicySetRQ, permitCreateObjRule } from './utils';
import { GrpcMockServer, ProtoUtils } from '@alenon/grpc-mock-server';
import * as proto_loader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import { unmarshallProtobufAny } from "../lib/utils";
import { Transform } from 'stream';
import * as _ from 'lodash';
import { ObjectServiceClient, ObjectServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/ostorage';
import { createClient as RedisCreateClient, RedisClientType } from 'redis';

let cfg: any;
let logger;
let worker: Worker;
// For event listeners
let events: Events;
let topic: Topic;
let ostorageService: ObjectServiceClient;
let redisClient: RedisClientType;
let tokenRedisClient: RedisClientType;

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
  owners: [{
    id: 'urn:restorecommerce:acs:names:ownerIndicatoryEntity',
    value: 'urn:restorecommerce:acs:model:organization.Organization',
    attributes: [{
      id: 'urn:restorecommerce:acs:names:ownerInstance',
      value: 'orgC'
    }]
  }]
};

interface MethodWithOutput {
  method: string,
  output: any
};

// mainOrg -> orgA -> orgB -> orgC
const acsSubject = {
  id: 'admin_user_id',
  scope: 'orgC',
  token: 'valid_token',
  tokens: [{ token: 'valid_token', expires_in: 0 }],
  role_associations: [
    {
      role: 'admin-r-id',
      attributes: [{
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization',
        attributes: [{
          id: 'urn:restorecommerce:acs:names:roleScopingInstance',
          value: 'mainOrg'
        }]
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

const PROTO_PATH: string = 'node_modules/@restorecommerce/protos/io/restorecommerce/access_control.proto';
const PKG_NAME: string = 'io.restorecommerce.access_control';
const SERVICE_NAME: string = 'AccessControlService';

const pkgDef: grpc.GrpcObject = grpc.loadPackageDefinition(
  proto_loader.loadSync(PROTO_PATH, {
    includeDirs: ['node_modules/@restorecommerce/protos'],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
);

const proto: any = ProtoUtils.getProtoFromPkgDefinition(
  PKG_NAME,
  pkgDef
);

const mockServer = new GrpcMockServer('localhost:50061');

const startGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    isAllowed: (call: any, callback: any) => {
      if (call?.request?.context?.resources[0]?.value) {
        let ctxResources = JSON.parse(call.request.context.resources[0].value.toString());
        if (ctxResources?.id === 'config_invalid_scope' || call?.request?.target?.subjects[0]?.value.startsWith('invalid_subject_id')) {
          callback(null, { decision: 'DENY' });
        } else {
          const isAllowedResponse = methodWithOutput.filter(e => e.method === 'IsAllowed');
          const response: any = new proto.Response.constructor(isAllowedResponse[0].output);
          callback(null, response);
        }
      }
    },
    whatIsAllowed: (call: any, callback: any) => {
      // check the request object and provide UserPolicies / RolePolicies
      const whatIsAllowedResponse = methodWithOutput.filter(e => e.method === 'WhatIsAllowed');
      const response: any = new proto.ReverseQuery.constructor(whatIsAllowedResponse[0].output);
      callback(null, response);
    }
  };
  try {
    mockServer.addService(PROTO_PATH, PKG_NAME, SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos/'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServer.start();
    logger.info('Mock ACS Server started on port 50061');
  } catch (err) {
    logger.error('Error starting mock ACS server', err);
  }
};

const stopGrpcMockServer = async () => {
  await mockServer.stop();
  logger.info('Mock ACS Server closed successfully');
};

const IDS_PROTO_PATH = 'node_modules/@restorecommerce/protos/io/restorecommerce/user.proto';
const IDS_PKG_NAME = 'io.restorecommerce.user';
const IDS_SERVICE_NAME = 'UserService';

const mockServerIDS = new GrpcMockServer('localhost:50051');

// Mock server for ids - findByToken
const startIDSGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    findByToken: (call: any, callback: any) => {
      if (call.request.token === 'valid_token') {
        // admin user
        callback(null, { payload: acsSubject, status: { code: 200, message: 'success' } });
      }
    }
  };
  try {
    mockServerIDS.addService(IDS_PROTO_PATH, IDS_PKG_NAME, IDS_SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos/'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServerIDS.start();
    logger.info('Mock IDS Server started on port 50051');
  } catch (err) {
    logger.error('Error starting mock IDS server', err);
  }
};

const stopIDSGrpcMockServer = async () => {
  await mockServerIDS.stop();
  logger.info('Mock IDS Server closed successfully');
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
async function getOstorageService(clientCfg: any): Promise<ObjectServiceClient> {
  let ostorageService: ObjectServiceClient;
  logger = worker.logger;
  if (clientCfg) {
    ostorageService = createClient({
      ...clientCfg,
      logger
    }, ObjectServiceDefinition, createChannel(clientCfg.address));
  }
  return ostorageService;
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
  });
  let subject;

  describe('Object Storage with ACS enabled', () => {
    it('With valid subject scope should store the data to storage server using request streaming', async () => {
      // strat acs mock service
      // PERMIT mock
      bucketPolicySetRQ.policy_sets[0].policies[0].rules = [permitCreateObjRule];
      bucketPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', output: bucketPolicySetRQ },
      { method: 'IsAllowed', output: { decision: 'PERMIT' } }]);

      // start mock ids-srv needed for findByToken response and return subject
      await startIDSGrpcMockServer([{ method: 'findByToken', output: acsSubject }]);

      // set redis client
      // since its not possible to mock findByToken as it is same service, storing the token value with subject
      // HR scopes resolved to db-subject redis store and token to findByToken redis store
      const redisConfig = cfg.get('redis');
      redisConfig.database = cfg.get('redis:db-indexes:db-subject') || 0;
      redisClient = RedisCreateClient(redisConfig);
      redisClient.on('error', (err) => logger.error('Redis Client Error', err));
      await redisClient.connect();

      // for findByToken
      redisConfig.database = cfg.get('redis:db-indexes:db-findByToken') || 0;
      tokenRedisClient = RedisCreateClient(redisConfig);
      tokenRedisClient.on('error', (err) => logger.error('Redis client error in token cache store', err));
      await tokenRedisClient.connect();

      // store hrScopesKey and subjectKey to Redis index `db-subject`
      const hrScopeskey = `cache:${acsSubject.id}:${acsSubject.token}:hrScopes`;
      const subjectKey = `cache:${acsSubject.id}:subject`;
      await redisClient.set(subjectKey, JSON.stringify(acsSubject));
      await redisClient.set(hrScopeskey, JSON.stringify(acsSubject.hierarchical_scopes));

      // store user with tokens and role associations to Redis index `db-findByToken`
      await tokenRedisClient.set('admin-token', JSON.stringify(acsSubject));

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
      const responseStream = await ostorageService.get({
        key: 'config_acs_enabled.json',
        bucket: 'test',
        subject
      });
      for await (const data of responseStream) {
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
      }
      sleep.sleep(3);
    });
    it('With valid subject scope should be able to list the object', async () => {
      let result = await ostorageService.list({ bucket: 'test', subject });
      should.exist(result.responses);
      result.responses.length.should.equal(1);
    });
    it('With invalid subject scope should throw an error when storing object', async () => {
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
      const responseStream = await ostorageService.get({
        key: 'config_acs_enabled.json',
        bucket: 'test',
        subject
      });
      for await (let data of responseStream) {
        should.not.exist(data.response.payload);
        should.exist(data.response.status);
        data.response.status.id.should.equal('config_acs_enabled.json');
        data.response.status.code.should.equal(403);
        data.response.status.message.should.equal('Access not allowed for request with subject:invalid_subject_id_1, resource:test, action:READ, target_scope:orgC; the response was DENY');
      }
      sleep.sleep(3);
    });
    it('With invalid subject scope should throw an error when listing object', async () => {
      // make sub id invalid so that data is not read from ACS cache
      subject.id = 'invalid_subject_id_2';
      let result = await ostorageService.list({
        bucket: 'test',
        subject
      });
      should(result.responses).empty;
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

      should.exist(result.responses);
      result.responses[0].status.id.should.equal('config_acs_enabled.json');
      result.responses[0].status.code.should.equal(403);
      result.responses[0].status.message.should.equal('Access not allowed for request with subject:invalid_subject_id_4, resource:test, action:READ, target_scope:orgC; the response was DENY');
      sleep.sleep(3);
    });
    it('With valid scope should replace the object', async () => {
      subject.id = 'admin_user_id';
      subject.scope = 'orgC'; // setting valid subject scope
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
      should.exist(result.responses);

      let payload = result.responses[0].payload;
      should.exist(payload.bucket);
      should.exist(payload.copySource);
      should.exist(payload.key);
      should.exist(payload.meta.owners[0].attributes[0].value);
      payload.meta.owners[0].attributes[0].value.should.equal('orgC');
      should.exist(payload.options.encoding);
      should.exist(payload.options.tags[0].id);

      payload.bucket.should.equal('test');
      payload.copySource.should.equal('test/config_acs_enabled.json');
      payload.key.should.equal('config_acs_enabled.json');
      payload.meta.owners.should.deepEqual(meta.owners);
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
      result.status[0].id.should.equal('config_acs_enabled.json');
      result.status[0].code.should.equal(200);
      result.status[0].message.should.equal('success');
      await stopGrpcMockServer();
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
      let result = await ostorageService.list({});
      should(result.responses).empty;
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });

    it('should upload object with umlauts ä_ö_ü.json and validate objectUploaded event and list object, read object, move object and finally delete the object', async () => {
      // Create an event listener for the "objectUploaded" event and when an
      // object is uploaded, consume the event and validate the fields being sent.
      const listener = function (msg: any, context: any, config: any, eventName: string): void {
        if (eventName == 'objectUploaded') {
          const key = msg.key;
          const bucket = msg.bucket;
          should.exist(key);
          should.exist(bucket);
          // key.should.equal('second_config.json');
          bucket.should.equal('test');
        }
      };
      topic = await events.topic('io.restorecommerce.ostorage');
      topic.on('objectUploaded', listener);

      const readStream = fs.createReadStream('./test/cfg/testObject.json');
      const transformBuffObj = () => {
        return new Transform({
          objectMode: true,
          transform: (chunk, _, done) => {
            // object buffer
            const data = {
              bucket: 'test',
              key: 'ä_ö_ü.json',
              object: chunk,
              meta,
              options,
              subject: { scope: 'orgC' }
            };
            done(null, data);
          }
        });
      };
      // store object
      const putResponse = await ostorageService.put(readStream.pipe(transformBuffObj()));
      putResponse.response.payload.key.should.equal('ä_ö_ü.json');
      putResponse.response.payload.url.should.equal('//test/%C3%A4_%C3%B6_%C3%BC.json');

      // list object
      let listResponse = await ostorageService.list({
        bucket: 'test'
      });
      should.exist(listResponse);
      should.exist(listResponse.responses);
      should.exist(listResponse.responses[0].payload);
      should(listResponse.responses).length(1);
      listResponse.responses[0].payload.object_name.should.equal('ä_ö_ü.json');
      listResponse.operation_status.code.should.equal(200);
      listResponse.operation_status.message.should.equal('success');

      // read object
      const responseStream = await ostorageService.get({
        key: 'ä_ö_ü.json',
        bucket: 'test'
      });
      for await (let data of responseStream) {
        if (data?.response?.payload) {
          should.exist(data.response.payload.key);
          data.response.payload.key.should.equal('ä_ö_ü.json');
          should.exist(data.response.payload.bucket);
          data.response.payload.bucket.should.equal('test');
          should.exist(data.response.payload.url);
          data.response.payload.url.should.equal('//test/ä_ö_ü.json');
          should.exist(data.response.payload.object);
          const objectValue = JSON.parse(data.response.payload.object.toString()).testKey;
          should.exist(objectValue);
          objectValue.should.equal('testValue');
          meta.owners.should.deepEqual(data.response.payload.meta.owners);
        } else {
          // emitted on end event with no payload
          should.exist(data.operation_status);
          data.operation_status.code.should.equal(200);
          data.operation_status.message.should.equal('success');
        }
      }

      sleep.sleep(3);

      // move object - ä_ö_ü.json to moved.json
      let moveResponse = await ostorageService.move({
        items: [{
          bucket: 'test2',
          key: 'moved.json',
          sourceObject: 'test/ä_ö_ü.json'
        }]
      });
      // validate moveResponse
      should.exist(moveResponse.responses);
      should(moveResponse.responses).length(1);
      should.exist(moveResponse.responses[0].payload);
      should.exist(moveResponse.responses[0].status.code);
      moveResponse.responses[0].status.code.should.equal(200);

      // validate test bucket response should be empty
      listResponse = await ostorageService.list({
        bucket: 'test',
      });
      should(listResponse.responses).empty;
      listResponse.operation_status.code.should.equal(200);

      // validate test2 bucket response should contain 2 objects
      let listResponse2 = await ostorageService.list({
        bucket: 'test2',
      });
      should.exist(listResponse2);
      should.exist(listResponse2.responses);
      should.exist(listResponse2.responses[0].payload);
      listResponse2.responses[0].payload.url.should.equal('//test2/moved.json');
      should(listResponse2.responses).length(1);
      listResponse2.operation_status.code.should.equal(200);
      listResponse2.operation_status.message.should.equal('success');
      sleep.sleep(3);

      // delete object moved.json from test2 bucket
      let delResponse = await ostorageService.delete({
        bucket: 'test2',
        key: 'moved.json'
      });
      delResponse.status[0].id.should.equal('moved.json');
      delResponse.status[0].code.should.equal(200);
      sleep.sleep(3);
    });

    it('Should store the data to storage server using request streaming', async () => {
      const readStream = fs.createReadStream('./test/cfg/testObject.json');

      const transformBuffObj = () => {
        return new Transform({
          objectMode: true,
          transform: (chunk, _, done) => {
            // object buffer
            const data = {
              bucket: 'test',
              key: 'config.json',
              object: chunk,
              meta,
              options,
              subject: { scope: 'orgC' }
            };
            done(null, data);
          }
        });
      };


      const putResponse = await ostorageService.put(readStream.pipe(transformBuffObj()));
      should.exist(putResponse.response.payload.bucket);
      should.exist(putResponse.response.payload.key);
      should.exist(putResponse.response.payload.url);
      should.exist(putResponse.response.payload.meta);
      should.exist(putResponse.response.payload.tags);
      putResponse.response.payload.key.should.equal('config.json');
      putResponse.response.payload.bucket.should.equal('test');
      putResponse.response.payload.url.should.equal('//test/config.json');

      // check meta
      putResponse.response.payload.meta.owners.should.deepEqual(meta.owners);

      // check tags
      putResponse.response.payload.tags[0].id.should.equal('id_1');
      putResponse.response.payload.tags[0].value.should.equal('value_1');
      putResponse.response.payload.tags[1].id.should.equal('id_2');
      putResponse.response.payload.tags[1].value.should.equal('value_2');

      // check length
      putResponse.response.payload.length.should.equal(29);
      sleep.sleep(3);
    });

    it('should get metadata of the Object', async () => {
      const responseStream = await ostorageService.get({
        key: 'config.json',
        bucket: 'test'
      });

      for await (let data of responseStream) {
        if (data?.response?.payload) {
          should.exist(data.response.payload.key);
          data.response.payload.key.should.equal('config.json');
          should.exist(data.response.payload.bucket);
          data.response.payload.bucket.should.equal('test');
          should.exist(data.response.payload.url);
          data.response.payload.url.should.equal('//test/config.json');
          should.exist(data.response.payload.object);
          const objectValue = JSON.parse(data.response.payload.object.toString()).testKey;
          should.exist(objectValue);
          objectValue.should.equal('testValue');
          meta.owners.should.deepEqual(data.response.payload.meta.owners);
        } else {
          // emitted on end event with no payload
          should.exist(data.operation_status);
          data.operation_status.code.should.equal(200);
          data.operation_status.message.should.equal('success');
        }
      }
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
            const metadata = unmarshallProtobufAny(msg.metadata, logger);

            // // what we expect
            const responseMetadata = {
              optionsObj: {
                encoding: "gzip",
                content_type: "application/pdf",
                content_language: "en-UK",
                content_disposition: "inline",
                length: 29
              },
              metaObj: {
                owner: [
                  {
                    id: "urn:restorecommerce:acs:names:ownerIndicatoryEntity",
                    value: "urn:restorecommerce:acs:model:organization.Organization",
                    attributes: [{
                      id: 'urn:restorecommerce:acs:names:ownerInstance',
                      value: 'orgC'
                    }]
                  }
                ],
                acls: [],
                created: 0,
                modified: 0,
                modified_by: 'SYSTEM'
              },
              data: {},
              meta_subject: {}
            };

            should.exist(key);
            should.exist(bucket);
            should.exist(metadata);

            key.should.equal('config.json');
            bucket.should.equal('test');
            metadata.optionsObj.encoding.should.equal(responseMetadata.optionsObj.encoding);
            metadata.optionsObj.content_type.should.equal(responseMetadata.optionsObj.content_type);
            // TODO currently conent_language is not sent back, need to investiage this
            // metadata.optionsObj.content_language.should.equal(responseMetadata.optionsObj.content_language);
            metadata.optionsObj.content_disposition.should.equal(responseMetadata.optionsObj.content_disposition);
            metadata.optionsObj.length.should.equal(responseMetadata.optionsObj.length);
            // metadata.metaObj.should.deepEqual(responseMetadata.metaObj);
          }
        };

        topic = await events.topic('io.restorecommerce.ostorage');
        topic.on('objectDownloadRequested', listener);

        const streamResponse = await ostorageService.get({
          key: 'config.json',
          bucket: 'test'
        });
        for await (let data of streamResponse) {
          if (data?.response?.payload) {
            should.exist(data.response.payload.key);
            data.response.payload.key.should.equal('config.json');
            should.exist(data.response.payload.bucket);
            data.response.payload.bucket.should.equal('test');
            should.exist(data.response.payload.url);
            data.response.payload.url.should.equal('//test/config.json');
            should.exist(data.response.payload.object);
            const objectValue = JSON.parse(data.response.payload.object.toString()).testKey;
            should.exist(objectValue);
            objectValue.should.equal('testValue');
            meta.owners.should.deepEqual(data.response.payload.meta.owners);
          } else {
            // emitted on end event with no payload
            should.exist(data.operation_status);
            data.operation_status.code.should.equal(200);
            data.operation_status.message.should.equal('success');
          }
        }
        sleep.sleep(3);
      });

    it('should list the Object', async () => {
      let listResponse = await ostorageService.list({
        bucket: 'test'
      });
      should.exist(listResponse);
      should.exist(listResponse.responses);
      should.exist(listResponse.responses[0].payload);
      should(listResponse.responses).length(1);
      listResponse.operation_status.code.should.equal(200);
      listResponse.operation_status.message.should.equal('success');
      sleep.sleep(3);
    });

    it('should give an error for invalid bucket request', async () => {
      let result = await ostorageService.list({
        bucket: 'invalid_bucket'
      });
      should.not.exist(result.responses);
      result.operation_status.message.should.equal('The specified bucket is not valid.');
      sleep.sleep(3);
    });

    it('Should replace the object', async () => {
      // create streaming client request
      const data = {
        items: [{
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
        }]
      };

      let replaceResponse = await ostorageService.copy(data);
      should.exist(replaceResponse.responses);
      should.exist(replaceResponse.responses[0].payload);

      let payload = replaceResponse.responses[0].payload;
      should.exist(payload.bucket);
      should.exist(payload.copySource);
      should.exist(payload.key);
      should.exist(payload.meta.owners[0].attributes[0].value);
      payload.meta.owners[0].attributes[0].value.should.equal('orgC');
      should.exist(payload.options.encoding);
      should.exist(payload.options.tags[0].id);

      payload.bucket.should.equal('test');
      payload.copySource.should.equal('test/config.json');
      payload.key.should.equal('config.json');
      payload.meta.owners.should.deepEqual(meta.owners);
      payload.options.encoding.should.equal('gzip');
      payload.options.tags[0].id.should.equal('id_1');
      sleep.sleep(3);
    });

    it('should upload another object and validate objectUploaded event and list both objects', async () => {
      // Create an event listener for the "objectUploaded" event and when an
      // object is uploaded, consume the event and validate the fields being sent.
      const listener = function (msg: any, context: any, config: any, eventName: string): void {
        if (eventName == 'objectUploaded') {
          const key = msg.key;
          const bucket = msg.bucket;
          should.exist(key);
          should.exist(bucket);
          key.should.equal('second_config.json');
          bucket.should.equal('test');
        }
      };
      topic = await events.topic('io.restorecommerce.ostorage');
      topic.on('objectUploaded', listener);

      const readStream = fs.createReadStream('./test/cfg/config.json');
      const transformBuffObj = () => {
        return new Transform({
          objectMode: true,
          transform: (chunk, _, done) => {
            // object buffer
            const data = {
              bucket: 'test',
              key: 'second_config.json',
              object: chunk,
              meta,
              options,
              subject: { scope: 'orgC' }
            };
            done(null, data);
          }
        });
      };
      const putResponse = await ostorageService.put(readStream.pipe(transformBuffObj()));
      let listResponse = await ostorageService.list({
        bucket: 'test'
      });
      should.exist(listResponse);
      should.exist(listResponse.responses);
      should.exist(listResponse.responses[0].payload);
      should.exist(listResponse.responses[1].payload);
      should(listResponse.responses).length(2);
      listResponse.operation_status.code.should.equal(200);
      listResponse.operation_status.message.should.equal('success');
      sleep.sleep(3);
    });

    it('should list one object with prefix', async () => {
      let listResponse = await ostorageService.list({
        bucket: 'test',
        prefix: 'con'
      });
      should.exist(listResponse);
      should.exist(listResponse.responses);
      should.exist(listResponse.responses[0].payload);
      should(listResponse.responses).length(1);
      listResponse.operation_status.code.should.equal(200);
      listResponse.operation_status.message.should.equal('success');
      sleep.sleep(3);
    });

    it('should list one object with max keys', async () => {
      let listResponse = await ostorageService.list({
        bucket: 'test',
        max_keys: 1
      });
      should.exist(listResponse);
      should.exist(listResponse.responses);
      should.exist(listResponse.responses[0].payload);
      should(listResponse.responses).length(1);
      listResponse.operation_status.code.should.equal(200);
      listResponse.operation_status.message.should.equal('success');
      sleep.sleep(3);
    });

    it('should move objects from one bucket to another', async () => {
      let moveResponse = await ostorageService.move({
        items: [{
          bucket: 'test2',
          key: 'config_new.json',
          sourceObject: 'test/config.json'
        }, {
          bucket: 'test2',
          key: 'second_config_new.json',
          sourceObject: 'test/second_config.json'
        }]
      });
      // validate moveResponse
      should.exist(moveResponse.responses);
      should(moveResponse.responses).length(2);
      should.exist(moveResponse.responses[0].payload);
      should.exist(moveResponse.responses[1].payload);
      should.exist(moveResponse.responses[0].status.code);
      moveResponse.responses[0].status.code.should.equal(200);
      moveResponse.responses[1].status.code.should.equal(200);

      // validate test bucket response should be empty
      let listResponse = await ostorageService.list({
        bucket: 'test',
      });
      should(listResponse.responses).empty;
      listResponse.operation_status.code.should.equal(200);

      // validate test2 bucket response should contain 2 objects
      let listResponse2 = await ostorageService.list({
        bucket: 'test2',
      });
      should.exist(listResponse2);
      should.exist(listResponse2.responses);
      should.exist(listResponse2.responses[0].payload);
      should.exist(listResponse2.responses[1].payload);
      listResponse2.responses[0].payload.url.should.equal('//test2/config_new.json');
      listResponse2.responses[1].payload.url.should.equal('//test2/second_config_new.json');
      should(listResponse2.responses).length(2);
      listResponse2.operation_status.code.should.equal(200);
      listResponse2.operation_status.message.should.equal('success');
      sleep.sleep(3);
    });

    it('should delete the object', async () => {
      let delResponse = await ostorageService.delete({
        bucket: 'test2',
        key: 'config_new.json'
      });
      delResponse.status[0].id.should.equal('config_new.json');
      delResponse.status[0].code.should.equal(200);
      delResponse.status[0].message.should.equal('success');
      delResponse.operation_status.code.should.equal(200);
      delResponse.operation_status.message.should.equal('success');
      let delResponse1 = await ostorageService.delete({
        bucket: 'test2',
        key: 'second_config_new.json'
      });
      delResponse1.status[0].id.should.equal('second_config_new.json');
      delResponse1.status[0].code.should.equal(200);
      delResponse1.status[0].message.should.equal('success');
      delResponse1.operation_status.code.should.equal(200);
      delResponse1.operation_status.message.should.equal('success');
    });

  });
});
