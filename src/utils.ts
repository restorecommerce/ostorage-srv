import {
  AuthZAction, PolicySetRQResponse, accessRequest,
  DecisionResponse, Operation
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger } from '@restorecommerce/logger';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { ServiceDefinition as UserServiceDefinition, ServiceClient as UserServiceClient } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import { errors } from '@restorecommerce/chassis-srv';
import { HeadObjectParams } from './interfaces';
import { S3 } from 'aws-sdk';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';

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

export interface Resource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

export interface Attribute {
  id: string;
  value: string;
  attribute: Attribute[];
}

export interface CtxResource {
  id: string;
  meta: {
    created?: number;
    modified?: number;
    modified_by?: string;
    owner: Attribute[]; // id and owner is mandatory in ctx resource other attributes are optional
  };
  [key: string]: any;
}

export interface GQLClientContext {
  // if subject is missing by default it will be treated as unauthenticated subject
  subject?: Subject;
  resources?: CtxResource[];
}

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param operation The operation to invoke either isAllowed or whatIsAllowed
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction,
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
      obligation: [],
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
          logger.error('Error occurred while retrieving metadata for object',
            {
              Bucket: headObjectParams.Bucket, Key: headObjectParams.Key, error: err, errorStack: err.stack
            });
          // map the s3 error codes to standard chassis-srv errors
          if (err.code === 'NotFound') {
            logger.info(`Object metadata for Key ${headObjectParams.Key} not found`);
            resolve({
              status: {
                id: headObjectParams.Key,
                code: err.code || 500,
                message: err.message
              }
            });
          }
          if (!err.message) {
            err.message = err.name;
          }
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  } catch (err) {
    logger.error('Error occurred while retrieving metadata for object', err);
    return {
      status: {
        id: headObjectParams.Key,
        code: err.code || 500,
        message: err.message
      }
    };
  }
};