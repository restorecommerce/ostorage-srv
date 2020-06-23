import * as should from 'should';
import { Worker } from '../lib/worker';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import * as sleep from 'sleep';
import * as fs from 'fs';

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
      value:'value_1'
    },
    {
      id: 'id_2',
      value:'value_2'
    }
  ]
};

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

async function start(): Promise<void> {
  cfg = sconfig(process.cwd() + '/test');
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

      let FinalResponse: any = await new Promise(async (resolve, reject) => {
        readStream.on('end', async () => {

          const streamingResponse = await new Promise((resolve, reject) => {
            streamRequest((err, data) => {
              if (err) {
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

      // Response object should include an error in the protos

      should.exist(FinalResponse.bucket);
      FinalResponse.bucket.should.equal('Invalid object name');

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
      response.meta.created.should.equal(0);
      response.meta.modified.should.equal(0);
      response.meta.modified_by.should.equal('SYSTEM');
      response.meta.owner[0].id.should.equal('urn:restorecommerce:acs:names:ownerIndicatoryEntity');
      response.meta.owner[0].value.should.equal('urn:restorecommerce:acs:model:user.User');
      response.meta.owner[1].id.should.equal('urn:restorecommerce:acs:names:ownerInstance');
      response.meta.owner[1].value.should.equal('UserID');

      // check tags
      response.tags[0].id.should.equal('id_1');
      response.tags[0].value.should.equal('value_1');
      response.tags[1].id.should.equal('id_2');
      response.tags[1].value.should.equal('value_2');

      // check length
      response.length.should.equal(6491);

      sleep.sleep(3);
    });

    it('should get metadata of the Object', async () => {
      const clientConfig = cfg.get('grpc-client:service-ostorage');
      const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
      const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
      const call = await get({
        key: 'config.json',
        bucket: 'test',
        flag: true
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
            tags : [
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
      response[0].meta.owner[1].value.should.equal('UserID');
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
