import * as mocha from 'mocha';
import * as should from 'should';
import * as assert from 'assert';
import { Worker } from '../worker';
import * as Logger from '@restorecommerce/logger';
import * as grpcClient from '@restorecommerce/grpc-client';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import { Metadata } from 'grpc';

const Events = kafkaClient.Events;

let cfg: any;
let logger;
let client;
let worker: Worker;
// For event listeners
let events;
let topic;

async function start(): Promise<void> {
    cfg = sconfig(process.cwd() + '/test');
    worker = new Worker(cfg);
    await worker.start();
}

async function stop(): Promise<void> {
    await worker.stop();
}

async function connect(clientCfg: string, resourceName: string): Promise<any> { // returns a gRPC service
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

    describe('Testing ostorage methods', () => {

        it('Should be empty', async () => {
            let oStorage = await connect('grpc-client:service-ostorage', '');
            let result = await oStorage.list();
            should(result.data.file_information).empty;
        });

        it('Should add data to ostorage', async () => {
            let oStorage = await connect('grpc-client:service-ostorage', '');
            let meta = {
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

            let result = await oStorage.put({
                bucket: 'invoices',
                key: 'test_object_234',
                object: "Test object.",
                meta: meta
            });
            should(result.error).null;
            should.exist(result.data.bucket);
            should.exist(result.data.key);
            
            var itemKey = result.data.key;
            var itemBucket = result.data.bucket;
            result = await oStorage.list({
                bucket: itemBucket
            });
            should(result.data.file_information).length(1);

            result = await oStorage.delete({
                bucket: itemBucket,
                key: itemKey
            });
            should(result.error).null;
            should(result.data).empty;
        });
    });
});