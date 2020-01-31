import * as chassis from '@restorecommerce/chassis-srv';
import { Events } from '@restorecommerce/kafka-client';
import { Unimplemented } from '@restorecommerce/chassis-srv/lib/microservice/errors';

export class OStorageCommandInterface extends chassis.CommandInterface {
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events) {
    super(server, cfg, logger, events);
  }

  async restore(payload: any): Promise<any> {
    throw new Unimplemented('Restore not implemented');
  }

  async reset(): Promise<any> {
    throw new Unimplemented('Reset not implemented');
  }
}