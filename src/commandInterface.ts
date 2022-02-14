import * as chassis from '@restorecommerce/chassis-srv';
import { Events } from '@restorecommerce/kafka-client';
import { updateConfig } from '@restorecommerce/acs-client';
import { Unimplemented } from '@restorecommerce/chassis-srv/lib/microservice/errors';
import { RedisClientType } from 'redis';

export class OStorageCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events, redisClient: RedisClientType<any, any>) {
    super(server, cfg, logger, events, redisClient);
  }

  async restore(payload: any): Promise<any> {
    throw new Unimplemented('Restore not implemented');
  }

  async reset(): Promise<any> {
    throw new Unimplemented('Reset not implemented');
  }

  async setApiKey(payload: any): Promise<any> {
    const commandResponse = await super.setApiKey(payload);
    updateConfig(this.config);
    return commandResponse;
  }

  async configUpdate(payload: any): Promise<any> {
    const commandResponse = await super.configUpdate(payload);
    updateConfig(this.config);
    return commandResponse;
  }
}
