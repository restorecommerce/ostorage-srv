"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const should = require("should");
const worker_1 = require("../lib/worker");
const grpcClient = require("@restorecommerce/grpc-client");
const kafkaClient = require("@restorecommerce/kafka-client");
const sconfig = require("@restorecommerce/service-config");
const sleep = require("sleep");
const fs = require("fs");
const Events = kafkaClient.Events;
let cfg;
let logger;
let client;
let worker;
// For event listeners
let events;
let oStorage;
function start() {
    return __awaiter(this, void 0, void 0, function* () {
        cfg = sconfig(process.cwd() + '/test');
        worker = new worker_1.Worker(cfg);
        yield worker.start();
    });
}
function stop() {
    return __awaiter(this, void 0, void 0, function* () {
        yield worker.stop();
    });
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
function connect(clientCfg, resourceName) {
    return __awaiter(this, void 0, void 0, function* () {
        logger = worker.logger;
        events = new Events(cfg.get('events:kafka'), logger);
        yield (events.start());
        client = new grpcClient.Client(cfg.get(clientCfg), logger);
        const service = yield client.connect();
        return service;
    });
}
describe('testing ostorage-srv', () => {
    before(function startServer() {
        return __awaiter(this, void 0, void 0, function* () {
            yield start();
        });
    });
    after(function stopServer() {
        return __awaiter(this, void 0, void 0, function* () {
            yield stop();
        });
    });
    describe('Object Storage', () => {
        it('Should be empty initially', () => __awaiter(void 0, void 0, void 0, function* () {
            oStorage = yield connect('grpc-client:service-ostorage', '');
            let result = yield oStorage.list();
            should(result.data.file_information).empty;
        }));
        it('Should store the data to storage server using request streaming', () => __awaiter(void 0, void 0, void 0, function* () {
            let response;
            // create streaming client request
            const clientConfig = cfg.get('grpc-client:service-ostorage');
            const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
            const put = client.makeEndpoint('put', clientConfig.publisher.instances[0]);
            const call = yield put();
            const readStream = fs.createReadStream('./test/cfg/config.json');
            readStream.on('data', (chunk) => __awaiter(void 0, void 0, void 0, function* () {
                const data = {
                    bucket: 'test',
                    key: 'config.json',
                    object: chunk,
                    meta
                };
                yield call.write(data);
            }));
            response = yield new Promise((resolve, reject) => __awaiter(void 0, void 0, void 0, function* () {
                readStream.on('end', () => __awaiter(void 0, void 0, void 0, function* () {
                    response = yield call.end((err, data) => { });
                    response = yield new Promise((resolve, reject) => {
                        response((err, data) => {
                            resolve(data);
                        });
                    });
                    resolve(response);
                    return response;
                }));
            }));
            should(response.error).null;
            should.exist(response.bucket);
            should.exist(response.key);
            should.exist(response.url);
            response.key.should.equal('config.json');
            response.bucket.should.equal('test');
            response.url.should.equal('http://localhost:5000/test/config.json');
            sleep.sleep(3);
        }));
        it('should get metadata of the Object', () => __awaiter(void 0, void 0, void 0, function* () {
            const clientConfig = cfg.get('grpc-client:service-ostorage');
            const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
            const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
            const call = yield get({
                key: 'config.json',
                bucket: 'test',
                flag: true
            });
            let result;
            result = yield call.read();
            result = yield new Promise((resolve, reject) => {
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
        }));
        it('should get the Object with response streaming', () => __awaiter(void 0, void 0, void 0, function* () {
            const clientConfig = cfg.get('grpc-client:service-ostorage');
            const client = new grpcClient.grpcClient(clientConfig.transports.grpc, logger);
            const get = client.makeEndpoint('get', clientConfig.publisher.instances[0]);
            const call = yield get({
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
                    result = yield call.read();
                    result = yield new Promise((resolve, reject) => {
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
            }
            catch (err) {
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
        }));
        it('should list the Object', () => __awaiter(void 0, void 0, void 0, function* () {
            let result = yield oStorage.list({
                bucket: 'test'
            });
            should.exist(result);
            should.exist(result.data);
            should.exist(result.data.object_data);
            should(result.data.object_data).length(1);
            sleep.sleep(3);
        }));
        it('should throw an error for invalid bucket request', () => __awaiter(void 0, void 0, void 0, function* () {
            let result = yield oStorage.list({
                bucket: 'invalid_bucket'
            });
            should.exist(result);
            should.exist(result.error);
            should.exist(result.error.details);
            result.error.details.should.equal('13 INTERNAL: The specified bucket does not exist');
            sleep.sleep(3);
        }));
        it('should delete the object', () => __awaiter(void 0, void 0, void 0, function* () {
            let result = yield oStorage.delete({
                bucket: 'test',
                key: 'config.json'
            });
            should(result.error).null;
            should(result.data).empty;
        }));
    });
});
