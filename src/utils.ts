import {
  AuthZAction, PolicySetRQResponse, accessRequest,
  DecisionResponse, Operation, ACSClientContext, Resource
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger } from '@restorecommerce/logger';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { UserServiceDefinition, UserServiceClient } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import { HeadObjectParams } from './interfaces';
import { S3 } from 'aws-sdk';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';

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
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
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

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param operation The operation to invoke either isAllowed or whatIsAllowed
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: ACSClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation): Promise<DecisionResponse | PolicySetRQResponse> {
  let subject = ctx.subject;
  // resolve subject id using findByToken api and update subject with id
  let dbSubject;
  if (subject && subject.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject && dbSubject.payload && dbSubject.payload.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(subject, resource, action, ctx, operation);
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

export const unmarshallProtobufAny = (msg: any): any => {
  return JSON.parse(msg.value.toString());
};

export const getHeadObject = async (headObjectParams: HeadObjectParams,
  ossClient: S3, logger: any): Promise<any> => {
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