import * as should from 'should';
import { Worker } from '../lib/worker';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import * as sleep from 'sleep';
import * as fs from 'fs';
import { Logger } from '@restorecommerce/logger';
import { Topic } from '@restorecommerce/kafka-client';

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




// async function start(): Promise<void> {
//   cfg = sconfig(process.cwd() + '/test');
//   worker = new Worker(cfg);
//   await worker.start();
// }
//
// async function stop(): Promise<void> {
//   await worker.stop();
// }

// // returns a gRPC service
// async function connect(clientCfg: string, resourceName: string): Promise<any> {
//   logger = worker.logger;
//
//   events = new Events(cfg.get('events:kafka'), logger);
//   await (events.start());
//
//   client = new grpcClient.Client(cfg.get(clientCfg), logger);
//   const service = await client.connect();
//   return service;
// }

describe('testing ostorage-srv with bucket lifecycle configuration', () => {

  let worker: Worker;

  let cfg: any;
  let logger: any;

  let marshall: any;
  let unmarshall: any;
  let listener: any;
  // we declare a global variable updateBucketConfigs here
  // this one is assigned during each test and executed when the event listener receives an event
  let updateBucketConfigs: any;

  let responseID: string;
  let response: Array<any>;
  let topic: Topic;

  before(async function start(): Promise<void> {
    console.log('beforeEach runs');

    cfg = sconfig(process.cwd() + '/test');
    logger = new Logger(cfg.get('logger'));

    updateBucketConfigs(cfg);
    worker = new Worker(cfg);
    await worker.start();

  });

  after(async function stop(): Promise<void> {
    await worker.stop();
  });

  describe('with test response listener', () => {
    before(async function start(): Promise<void> {
      console.log('before runs');
      events = new Events(cfg.get('events:kafka'), logger);
      await events.start();
      topic = events.topic('io.restorecommerce.ostoragetest');
      topic.on('BucketLifecycleCfg', listener);
    });
    after(async function stop(): Promise<void> {
      await events.stop();
    });
    it('should write configuration 1', async () => {
      let cfg: any[] = [];
      let cfg_1 =
        {
          "Bucket": "test",
          "LifecycleConfiguration": {
            "Rules": [
              {
                "Status": "Enabled",
                "Expiration": {
                  "Date": "2019-05-30T00:00:00.000Z"
                },
                "Filter": {
                  "Prefix": "temp/"
                },
                "ID": "Delete all files under folder and the folder as-well"
              }
            ]
          }
        };
      cfg.push(cfg_1);

      updateBucketConfigs = (cfg) => {
        // TODO depending on your test case 
        // you can remove or add bucketlfeConfigs here
      };
      const offset = await topic.$offset(-1) + 1;
      await topic.emit('BucketLifecycleCfg', cfg);
      await topic.$wait(offset);
    });

  })
});


// describe('testing ostorage-srv', () => {
//   before(async function startServer(): Promise<void> {
//     await start();
//   });
//
//   after(async function stopServer(): Promise<void> {
//     await stop();
//   });
//
//   describe('Object Storage', () => {
//     it('Should be empty initially', async () => {
//       oStorage = await connect('grpc-client:service-ostorage', '');
//       let result = await oStorage.list();
//       should(result.data.file_information).empty;
//     });
//     it('Should store the data to storage server using request streaming', async () => {
//       let response;
//       // create streaming client request
//       const clientConfig = cfg.get('grpc-client:service-ostorage');
//       const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
//       const put = client.makeEndpoint('put', clientConfig.publisher.instances[0]);
//       const call = await put();
//       const readStream = fs.createReadStream('./test/cfg/config.json');
//       readStream.on('data', async (chunk) => {
//         const data = {
//           bucket: 'test',
//           key: 'config.json',
//           object: chunk,
//           meta,
//           options
//         };
//         await call.write(data);
//       });
//
//       response = await new Promise(async (resolve, reject) => {
//         readStream.on('end', async () => {
//           response = await call.end((err, data) => { });
//           response = await new Promise((resolve, reject) => {
//             response((err, data) => {
//               resolve(data);
//             });
//           });
//           resolve(response);
//           return response;
//         });
//       });
//       should(response.error).null;
//
//       should.exist(response.bucket);
//       response.bucket.should.equal('test');
//
//       should.exist(response.key);
//       response.key.should.equal('config.json');
//
//       should.exist(response.url);
//       response.url.should.equal('http://localhost:5000/test/config.json');
//
//       should.exist(response.tags);
//       let tags = response.tags;
//       should.exist(tags[0].id && tags[0].value);
//       tags[0].id.should.equal('id_1');
//       tags[0].value.should.equal('value_1');
//       should.exist(tags[1].id && tags[1].value);
//       tags[1].id.should.equal('id_2');
//       tags[1].value.should.equal('value_2');
//
//       sleep.sleep(3);
//     });
//     it('should get metadata of the Object', async () => {
//       const clientConfig = cfg.get('grpc-client:service-ostorage');
//       const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
//       const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
//       const call = await get({
//         key: 'config.json',
//         bucket: 'test',
//         flag: true
//       });
//       let result;
//       result = await call.read();
//       result = await new Promise((resolve, reject) => {
//         result((err, response) => {
//           if (err) {
//             reject(err);
//           }
//           resolve(response);
//         });
//       });
//       should.exist(result);
//       should.exist(result.key);
//       should.exist(result.url);
//       should.exist(result.object);
//       meta.owner.should.deepEqual(result.meta.owner);
//       sleep.sleep(3);
//     });
//     it('should get the Object with response streaming', async () => {
//       const clientConfig = cfg.get('grpc-client:service-ostorage');
//       const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
//       const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
//       const call = await get({
//         key: 'config.json',
//         bucket: 'test'
//       });
//       let streamResponse = true;
//       let streamData = {
//         key: '', object: {}, url: '', error: { code: null, message: null }
//       };
//       let streamBuffer = [];
//       let result;
//       try {
//         while (streamResponse) {
//           result = await call.read();
//           result = await new Promise((resolve, reject) => {
//             result((err, response) => {
//               if (err) {
//                 reject(err);
//               }
//               resolve(response);
//             });
//           });
//           streamData.key = result.key;
//           streamData.url = result.url;
//           if (result.error) {
//             streamData.error = result.error;
//           }
//           streamBuffer.push(result.object);
//         }
//       } catch (err) {
//         streamResponse = false;
//         if (err.message === 'stream end') {
//           logger.info('readable stream ended.');
//         }
//       }
//       streamData.object = Buffer.concat(streamBuffer);
//       should.exist(streamData);
//       should.exist(streamData.object);
//       should.exist(streamData.key);
//       should.exist(streamData.url);
//       streamData.key.should.equal('config.json');
//       sleep.sleep(3);
//     });
//     it('should list the Object', async () => {
//       let result = await oStorage.list({
//         bucket: 'test'
//       });
//       should.exist(result);
//       should.exist(result.data);
//       should.exist(result.data.object_data);
//       should(result.data.object_data).length(1);
//       sleep.sleep(3);
//     });
//     it('should throw an error for invalid bucket request', async () => {
//       let result = await oStorage.list({
//         bucket: 'invalid_bucket'
//       });
//       should.exist(result);
//       should.exist(result.error);
//       should.exist(result.error.details);
//       result.error.details.should.equal('13 INTERNAL: The specified bucket does not exist');
//       sleep.sleep(3);
//     });
//     it('should delete the object', async () => {
//       let result = await oStorage.delete({
//         bucket: 'test',
//         key: 'config.json'
//       });
//       should(result.error).null;
//       should(result.data).empty;
//     });
//   });
// });
