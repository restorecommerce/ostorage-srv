import { createServiceConfig } from '@restorecommerce/service-config';
import * as _ from 'lodash';
import { Events } from '@restorecommerce/kafka-client';
import { createLogger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { Service } from './service';
import { OStorageCommandInterface } from './commandInterface';
import Redis from 'ioredis';
import { initAuthZ, ACSAuthZ, initializeCache } from '@restorecommerce/acs-client';
import { Logger } from 'winston';
import { GrpcClient } from '@restorecommerce/grpc-client';

export class Worker {
  events: Events;
  server: any;
  logger: Logger;
  cfg: any;
  topics: any;
  offsetStore: chassis.OffsetStore;
  authZ: ACSAuthZ;
  oss: Service;
  constructor(cfg?: any) {
    this.cfg = cfg || createServiceConfig(process.cwd());
    const loggerCfg = this.cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    this.logger = createLogger(loggerCfg);
    this.topics = {};
  }

  async start(): Promise<any> {
    // Load config
    const cfg = this.cfg;
    const logger = this.logger;
    const kafkaCfg = cfg.get('events:kafka');

    const server = new chassis.Server(cfg.get('server'), logger);

    // topics
    logger.verbose('Setting up topics');
    const events = new Events(cfg.get('events:kafka'), logger);
    await events.start();
    this.offsetStore = new chassis.OffsetStore(events, cfg, logger);

    let authZ = await initAuthZ(this.cfg) as ACSAuthZ;
    this.authZ = authZ;

    // init redisClient
    const redisConfig = cfg.get('redis');
    redisConfig.db = cfg.get('redis:db-indexes:db-subject');
    const redisClient = new Redis(redisConfig);

    // init ACS cache
    await initializeCache();

    // init ids-client to lookup token in case subject does not contain id
    const idsClientCfg = cfg.get('client:user');
    const idsClient = new GrpcClient(idsClientCfg, logger);
    const idsService = idsClient.user;

    const cis = new OStorageCommandInterface(server, cfg, logger, events, redisClient);

    const eventListener = async (msg: any, context: any, config: any, eventName: string) => {
      // command events
      await cis.command(msg, context);
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      this.topics[topicType] = await events.topic(topicName);
      const offSetValue = await this.offsetStore.getOffset(topicName);
      logger.info('subscribing to topic with offset value', topicName, offSetValue);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await this.topics[topicType].on(eventName,
            eventListener, { startingOffset: offSetValue });
        }
      }
    }

    redisConfig.db = cfg.get('redis:db-indexes:db-aclStore');
    const aclRedisClient = new Redis(redisConfig);
    const oss = new Service(cfg, logger, this.topics, this.authZ, idsService,
      aclRedisClient);
    this.oss = oss;

    // list of service names
    const serviceNamesCfg = cfg.get('serviceNames');
    await server.bind(serviceNamesCfg.ostorage, oss);
    await server.bind(serviceNamesCfg.cis, cis);

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await server.bind(reflectionServiceName, reflectionService);

    await server.bind(serviceNamesCfg.health, new chassis.Health(cis, {
      logger,
      cfg,
      dependencies: ['acs-srv'],
    }));

    // Start server
    await oss.start();
    await server.start();

    this.events = events;
    this.server = server;
  }

  async stop(): Promise<any> {
    this.logger.info('Shutting down');
    await this.server.stop();
    await this.events.stop();
    await this.offsetStore.stop();
  }
}

if (require.main === module) {
  const worker = new Worker();
  const logger = worker.logger;
  worker.start().then().catch((err) => {
    logger.error('startup error', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    worker.stop().then().catch((err) => {
      logger.error('shutdown error', err);
      process.exit(1);
    });
  });
}
