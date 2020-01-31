import * as sconfig from '@restorecommerce/service-config';
import * as _ from 'lodash';
import { Events } from '@restorecommerce/kafka-client';
import { Logger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { Service } from './service';
import { OStorageCommandInterface } from './commandInterface';

export class Worker {
  events: Events;
  server: any;
  logger: chassis.Logger;
  cfg: any;
  topics: any;
  offsetStore: chassis.OffsetStore;
  constructor(cfg?: any) {
    this.cfg = cfg || sconfig(process.cwd());
    this.logger = new Logger(this.cfg.get('logger'));
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

    const oss = new Service(cfg.get(), logger);
    const cis = new OStorageCommandInterface(server, cfg.get(), logger, events);

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
