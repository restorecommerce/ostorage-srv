import * as should from 'should';
import { Worker } from '../worker';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import * as sleep from 'sleep';

const Events = kafkaClient.Events;

let cfg: any;
let logger;
let client;
let worker: Worker;
// For event listeners
let events;
let oStorage;
let itemKey;

async function start(): Promise<void> {
  cfg = sconfig(process.cwd() + '/test');
  worker = new Worker(cfg);
  await worker.start();
}

async function stop(): Promise<void> {
  await worker.stop();
}

const meta = {
  modified_by: 'SYSTEM',
  owner: [{
    id: 'urn:restorecommerce:acs:names:ownerIndicatoryEntity',
    value: 'urn:restorecommerce:acs:model:user.User'
  },
  {
    id: 'urn:restorecommerce:acs:names:ownerInstance',
    value: 'UserID'
  }]
};

// returns a gRPC service
async function connect(clientCfg: string, resourceName: string): Promise<any> {
  logger = worker.logger;

  events = new Events(cfg.get('events:kafka'), logger);
  await (events.start());

  client = new grpcClient.Client(cfg.get(clientCfg), logger);
  const service = await client.connect();
  return service;
}

describe('testing ostorage-srv', () => {
  before(async function startServer(): Promise<void> {
    await start();
  });

  after(async function stopServer(): Promise<void> {
    await stop();
  });

  describe('Object Storage', () => {
    it('Should be empty initially', async () => {
      oStorage = await connect('grpc-client:service-ostorage', '');
      let result = await oStorage.list();
      should(result.data.file_information).empty;
    });
    it('Should store the Object', async () => {
      let result = await oStorage.put({
        bucket: 'invoices',
        key: 'test_object_123',
        object: 'Test object1',
        meta
      });
      itemKey = result.data.key;
      should(result.error).null;
      should.exist(result.data.bucket);
      should.exist(result.data.key);
      sleep.sleep(3);
    });
    it('should get metadata of the Object', async () => {
      let result = await oStorage.get({
        key: 'test_object_123',
        bucket: 'invoices',
        flag: true
      });
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.key);
      should.exist(result.data.meta.owner);
      meta.owner.should.deepEqual(result.data.meta.owner);
      sleep.sleep(3);
    });
    it('should get the Object', async () => {
      let result = await oStorage.get({
        key: 'test_object_123',
        bucket: 'invoices'
      });
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.key);
      result.data.key.should.equal('test_object_123');
      sleep.sleep(3);
    });
    it('should list the Object', async () => {
      let result = await oStorage.list({
        bucket: 'invoices'
      });
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
    it('should delete the object', async () => {
      let result = await oStorage.delete({
        bucket: 'invoices',
        key: itemKey
      });
      should(result.error).null;
      should(result.data).empty;
    });
  });
});