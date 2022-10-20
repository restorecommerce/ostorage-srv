import { createServiceConfig } from '@restorecommerce/service-config';
import * as _ from 'lodash';
import { Events, registerProtoMeta, Topic } from '@restorecommerce/kafka-client';
import { createLogger } from '@restorecommerce/logger';
import * as chassis from '@restorecommerce/chassis-srv';
import { Service } from './service';
import { OStorageCommandInterface } from './commandInterface';
import { createClient, RedisClientType } from 'redis';
import { initAuthZ, ACSAuthZ, initializeCache } from '@restorecommerce/acs-client';
import { Logger } from 'winston';
import { createChannel, createClient as createGrpcClient } from '@restorecommerce/grpc-client';
import { ServiceDefinition as OStorageServiceDefinition, protoMetadata as ostorageMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/ostorage';
import { ServiceDefinition as CommandInterfaceServiceDefinition, protoMetadata as commandInterfaceMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface';
import { HealthDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/health/v1/health';
import {
  protoMetadata as reflectionMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/reflection/v1alpha/reflection';
import { ServerReflectionService } from 'nice-grpc-server-reflection';
import { ServiceClient as UserServiceClient, ServiceDefinition as UserServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import { BindConfig } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc';

// register for kafka events
registerProtoMeta(ostorageMeta, commandInterfaceMeta, reflectionMeta);

interface Topics {
  [key: string]: Topic;
}

export class Worker {
  events: Events;
  server: any;
  logger: Logger;
  cfg: any;
  topics: Topics;
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
    const events: any = new Events(cfg.get('events:kafka'), logger);
    await events.start();
    this.offsetStore = new chassis.OffsetStore(events, cfg, logger);

    let authZ = await initAuthZ(this.cfg) as ACSAuthZ;
    this.authZ = authZ;

    // init redisClient
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject');
    const redisClient: RedisClientType<any, any> = createClient(redisConfig);
    redisClient.on('error', (err) => logger.error('Redis client error in subject store', err));
    await redisClient.connect();

    // init ACS cache
    await initializeCache();

    // init ids-client to lookup token in case subject does not contain id
    const idsClientCfg = cfg.get('client:user');
    let idsService: UserServiceClient;
    if (idsClientCfg) {
      idsService = createGrpcClient({
        ...idsClientCfg,
        logger
      }, UserServiceDefinition, createChannel(idsClientCfg.address));
    }

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

    redisConfig.database = cfg.get('redis:db-indexes:db-aclStore');
    const aclRedisClient: RedisClientType<any, any> = createClient(redisConfig);
    aclRedisClient.on('error', (err) => logger.error('Redis client error in ACL store', err));
    await aclRedisClient.connect();
    const oss = new Service(cfg, logger, this.topics, this.authZ, idsService,
      aclRedisClient);
    this.oss = oss;

    // list of service names
    const serviceNamesCfg = cfg.get('serviceNames');
    await server.bind(serviceNamesCfg.ostorage, {
      service: OStorageServiceDefinition,
      implementation: oss
    } as any);
    await server.bind(serviceNamesCfg.cis, {
      service: CommandInterfaceServiceDefinition,
      implementation: cis
    } as BindConfig<CommandInterfaceServiceDefinition>);

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const reflectionService = chassis.buildReflectionService([
      { descriptor: ostorageMeta.fileDescriptor },
      { descriptor: commandInterfaceMeta.fileDescriptor }
    ]);
    await server.bind(reflectionServiceName, {
      service: ServerReflectionService,
      implementation: reflectionService
    });

    await server.bind(serviceNamesCfg.health, {
      implementation: new chassis.Health(cis, {
        logger,
        cfg,
        dependencies: ['acs-srv'],
      }),
      service: HealthDefinition
    } as BindConfig<HealthDefinition>);

    // Start server
    await oss.start();
    await server.start();

    this.events = events;
    this.server = server;
    this.logger.info('Ostorage service started successfully');
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
