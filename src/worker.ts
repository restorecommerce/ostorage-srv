import { createServiceConfig } from '@restorecommerce/service-config';
import * as _ from 'lodash';
import { Events } from '@restorecommerce/kafka-client';
import { createLogger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { Service } from './service';
import { OStorageCommandInterface } from './commandInterface';
import { createClient } from 'redis';
import { initAuthZ, ACSAuthZ, initializeCache } from '@restorecommerce/acs-client';

export class Worker {
  events: Events;
  server: any;
  logger: chassis.Logger;
  cfg: any;
  topics: any;
  offsetStore: chassis.OffsetStore;
  authZ: ACSAuthZ;
  oss: Service;
  constructor(cfg?: any) {
    this.cfg = cfg || createServiceConfig(process.cwd());
    this.logger = createLogger(this.cfg.get('logger'));
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
    const redisClient = new createClient(redisConfig);

    // init ACS cache
    initializeCache();

    const oss = new Service(cfg, logger, this.authZ);
    const cis = new OStorageCommandInterface(server, cfg, logger, events, redisClient);
    this.oss = oss;

    const eventListener = async (msg: any, context: any, config: any, eventName: string) => {
      // command events
      await cis.command(msg, context);
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      this.topics[topicType] = events.topic(topicName);
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
