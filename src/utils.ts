import {
  AuthZAction, PolicySetRQResponse, accessRequest,
  DecisionResponse, Operation, ACSClientContext, Resource
} from '@restorecommerce/acs-client';
import * as _ from 'lodash-es';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger } from '@restorecommerce/logger';
import { Logger } from 'winston';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { UserServiceDefinition, UserServiceClient } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import { HeadObjectParams } from './interfaces.js';
import { S3 } from 'aws-sdk';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface Response {
  payload: any;
  count: number;
  status?: {
    code: number;
    message: string;
  };
}

export interface FilterType {
  field?: string;
  operation?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'in' | 'isEmpty' | 'iLike';
  value?: string;
  type?: 'string' | 'boolean' | 'number' | 'date' | 'array';
}

// Create a ids client instance
let idsClientInstance: UserServiceClient;
const cfg = createServiceConfig(process.cwd());
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      idsClientInstance = createClient({
        ...grpcIDSConfig,
        logger
      }, UserServiceDefinition, createChannel(grpcIDSConfig.address));
    }
  }
  return idsClientInstance;
};

export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction, operation: Operation.isAllowed, useCache?: boolean): Promise<DecisionResponse>;
export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction, operation: Operation.whatIsAllowed, useCache?: boolean): Promise<PolicySetRQResponse>;

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param operation The operation to invoke either isAllowed or whatIsAllowed
 */
export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation): Promise<DecisionResponse | PolicySetRQResponse> {
  const subject = ctx.subject;
  // resolve subject id using findByToken api and update subject with id
  let dbSubject;
  if (subject?.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject?.payload?.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(subject, resource, action, ctx, { operation, roleScopingEntityURN: cfg?.get('authorization:urns:roleScopingEntityURN') });
  } catch (err) {
    return {
      decision: Response_Decision.DENY,
      obligations: [],
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
}

export const marshallProtobufAny = (msg: any): any => {
  return {
    type_url: '',
    value: Buffer.from(JSON.stringify(msg))
  };
};

export const unmarshallProtobufAny = (msg: any, logger: Logger): any => {
  try {
    return JSON.parse(msg.value.toString());
  } catch (error) {
    logger.error('Error unmarshalling data', { code: error.code, message: error.message, stack: error.stack });
  }
};

export const getHeadObject = async (headObjectParams: HeadObjectParams,
  ossClient: S3, logger: Logger): Promise<any> => {
  try {
    return new Promise((resolve, reject) => {
      ossClient.headObject(headObjectParams, (err: any, data) => {
        if (err) {
          // map the s3 error codes to standard chassis-srv errors
          if (err.code === 'NotFound') {
            logger.info(`Object metadata for Key ${headObjectParams.Key} not found`);
            resolve({
              status: {
                id: headObjectParams.Key,
                code: 404,
                message: err.message ? err.message : `Object metadata for Key ${headObjectParams.Key} not found`
              }
            });
          }
          logger.error('Error occurred while retrieving metadata for object',
            {
              Bucket: headObjectParams.Bucket, Key: headObjectParams.Key, error: err, errorStack: err.stack
            });
          if (!err.message) {
            err.message = err.name;
          }
          reject(err);
        } else {
          logger.debug(`Object metadata for Key ${headObjectParams.Key}`, data);
          resolve(data);
        }
      });
    });
  } catch (error) {
    logger.error('Error occurred while retrieving metadata for object', { code: error.code, message: error.message, stack: error.stack });
    const code = Number.isNaN(error.code) ? 500 : error.code;
    return {
      status: {
        id: headObjectParams.Key,
        code,
        message: error.message
      }
    };
  }
};
