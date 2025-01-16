import * as _ from 'lodash-es';
import pkg from 'aws-sdk';
import { Readable } from 'node:stream';
import { errors } from '@restorecommerce/chassis-srv';
import {
  checkAccessRequest, unmarshallProtobufAny,
  marshallProtobufAny, getHeadObject
} from './utils.js';
import {
  AuthZAction, ACSAuthZ, PolicySetRQResponse,
  updateConfig, DecisionResponse, Operation
} from '@restorecommerce/acs-client';
import { CopyObjectParams } from './interfaces.js';
import { RedisClientType } from 'redis';
import { ListObjectsV2Request } from 'aws-sdk/clients/s3.js';
import {
  ServerStreamingMethodResult, DeepPartial, Object as PutObject, ObjectResponse, ListRequest,
  ListResponse, GetRequest, Options, PutResponse, MoveRequestList,
  MoveResponseList, CopyResponseList, CopyRequestList, CopyResponseItem, DeleteRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/ostorage.js';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Attribute } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/attribute.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import { Meta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/meta.js';
import { DeleteResponse } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { OperationStatus, Status } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/status.js';

const { S3 } = pkg;
const META_OWNER = 'meta.owners';
const EQ = 'eq';

const OPERATION_STATUS_SUCCESS = {
  code: 200,
  message: 'success'
};

export class Service {
  ossClient: S3; // object storage frameworks are S3-compatible
  buckets: string[];
  bucketsLifecycleConfigs?: any;
  authZ: ACSAuthZ;
  cfg: any;
  authZCheck: boolean;
  idsService: any;
  aclRedisClient: RedisClientType<any, any>;

  constructor(cfg: any, private logger: any, private topics: any, authZ: ACSAuthZ,
    idsService: any, aclRedisClient: RedisClientType<any, any>) {
    this.ossClient = new S3(cfg.get('s3:client'));
    this.buckets = cfg.get('s3:buckets') || [];
    this.bucketsLifecycleConfigs = cfg.get('s3.bucketsLifecycleConfigs');
    this.authZ = authZ;
    this.cfg = cfg;
    this.authZCheck = cfg.get('authorization:enabled');
    this.idsService = idsService;
    this.aclRedisClient = aclRedisClient;
  }

  async start(): Promise<void> {
    // Create buckets as defined in config.json
    for (const bucket of this.buckets) {
      await new Promise((resolve, reject) => {
        this.ossClient.createBucket({
          Bucket: bucket
        }, (err, data) => {
          if (err) {
            if (err.statusCode != 409) { // bucket already owned by you
              this.logger.error(`Error creating bucket ${bucket}`);
            }
          }
          resolve(data);
        });
      });
    }

    // Bucket lifecycle configuration
    // get a list of all the bucket names for which rules exist
    const existingBucketRules = [];
    // bucket names for which the existing rules should be deleted
    const deleteBucketRules = [];
    // bucket names for the rules in configuration
    const updateBucketRules = [];

    for (const bucket of this.buckets) {
      await new Promise((resolve, reject) => {
        this.ossClient.getBucketLifecycleConfiguration({ Bucket: bucket }, (err, data) => {
          if (err) {
            if (err.code == 'NoSuchLifecycleConfiguration') {
              this.logger.info(`No rules are preconfigured for bucket: ${bucket}`);
              resolve(err);
            } else {
              this.logger.error('Error occurred while retrieving BucketLifecycleConfiguration for bucket:',
                {
                  Bucket: bucket, error: err, errorStack: err.stack
                });
              reject(err);
            }
          } else {
            if (data?.Rules) {
              // rules are found, adding them to the list
              existingBucketRules.push(bucket);
              resolve(data);
            } else {
              // no data found
              this.logger.error(`No data found! Error occurred while retrieving BucketLifecycleConfiguration for bucket: ${bucket}`);
              reject(data);
            }
          }
        });
      });
    }

    // Check if lifecycle configuration is given
    if (this.bucketsLifecycleConfigs) {
      // check if there are any bucket rules to be removed
      for (const bucketLifecycleConfiguration of this.bucketsLifecycleConfigs) {
        updateBucketRules.push(bucketLifecycleConfiguration.Bucket);
      }

      for (const existingBucketRule of existingBucketRules) {
        if (!updateBucketRules.includes(existingBucketRule)) {
          deleteBucketRules.push(existingBucketRule);
        }
      }

      // delete rules
      for (const bucket of deleteBucketRules) {
        await new Promise((resolve, reject) => {
          this.ossClient.deleteBucketLifecycle({ Bucket: bucket }, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while removing BucketLifecycleConfiguration for bucket:',
                {
                  Bucket: bucket, error: err, errorStack: err.stack
                });
              reject(err);
            } else { // successful response
              this.logger.info(`Successfully removed BucketLifecycleConfiguration for bucket: ${bucket}`);
              resolve(data);
            }
          });
        });
      }

      // Upsert rules
      for (const bucketLifecycleParams of this.bucketsLifecycleConfigs) {
        const bucketName = bucketLifecycleParams.Bucket;
        await new Promise((resolve, reject) => {
          this.ossClient.putBucketLifecycleConfiguration(bucketLifecycleParams, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while adding BucketLifecycleConfiguration for:',
                {
                  bucket: bucketName, error: err, errorStack: err.stack
                });
              reject(err);
            } else { // successful response
              this.logger.info(`Successfully added BucketLifecycleConfiguration for bucket: ${bucketName}`);
              resolve(data);
            }
          });
        });
      }
    } else {
      // Check old rules if they exist in all the buckets and delete them.
      // This is for use case if the configurations were added previously and all of them are removed now.
      for (const existingBucketRule of existingBucketRules) {
        await new Promise((resolve, reject) => {
          this.ossClient.deleteBucketLifecycle({ Bucket: existingBucketRule }, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while removing BucketLifecycleConfiguration for bucket:',
                {
                  bucket: existingBucketRule, error: err, errorStack: err.stack
                });
              reject(err);
            } else { // successful response
              this.logger.info(`Successfully removed BucketLifecycleConfiguration for bucket: ${existingBucketRule}`);
              resolve(data);
            }
          });
        });
      }
    }
  }

  private filterObjects(requestFilter, object, listResponse) {
    // if filter is provided return data based on filter
    if (requestFilter && requestFilter?.filters && !_.isEmpty(requestFilter?.filters)) {
      const filters = requestFilter.filters[0];
      if (filters && filters?.field == META_OWNER && filters?.operation == EQ && filters?.value) {
        let metaOwnerVal;
        const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
        if (object?.meta?.owners && _.isArray(object.meta.owners)) {
          for (const owner of object.meta.owners) {
            if (owner?.attributes?.length > 0) {
              for (const ownerInstObj of owner.attributes) {
                if (ownerInstObj?.id === ownerInstanceURN) {
                  metaOwnerVal = ownerInstObj?.value;
                }
              }
            }
          }
          // check only for the files matching the requested Owner Organizations
          if (filters.value == metaOwnerVal) {
            listResponse.responses.push({
              payload: object,
              status: { id: object.object_name, code: 200, message: 'success' }
            });
          }
        }
      }
    } else { // else return all data
      listResponse.responses.push({
        payload: object,
        status: { id: object.object_name, code: 200, message: 'success' }
      });
    }
  }

  async list(request: ListRequest, ctx: any): Promise<DeepPartial<ListResponse>> {
    const { bucket, filters, max_keys, prefix } = request;
    this.logger.info(`Received a request to list objects on bucket ${bucket}`);
    const subject = request.subject;
    let acsResponse: PolicySetRQResponse; // WhatisAllowed check for Read operation
    try {
      if (!ctx) { ctx = {}; };
      // target entity for ACS is bucket name here
      ctx.subject = subject;
      ctx.resources = [];
      acsResponse = await checkAccessRequest(ctx, [{ resource: bucket }], AuthZAction.READ,
        Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv for list operation', err);
      return {
        operation_status: {
          code: Number.isInteger(err?.code) ? err.code : 500,
          message: err?.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    let customArgs;
    if (acsResponse?.custom_query_args?.length > 0) {
      customArgs = acsResponse.custom_query_args[0].custom_arguments;
    }
    const ownerIndictaorEntURN = this.cfg.get('authorization:urns:ownerIndicatoryEntity');
    const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
    let customArgsFilter, ownerValues, ownerIndicatorEntity;
    if (customArgs?.value) {
      try {
        customArgsFilter = JSON.parse(customArgs.value.toString());
      } catch (err: any) {
        const operation_status: OperationStatus = {
          code: Number.isInteger(err?.code) ? err.code : 500,
          message: err?.message,
        }
        this.logger.error('Error parsing ACS response in list endpoint', {
          operation_status,
          stack: err?.stack
        });
        return {
          operation_status
        };
      }
      // applicable target owners instances
      ownerValues = customArgsFilter.instance;
      ownerIndicatorEntity = customArgsFilter.entity;
    }

    let buckets = [];
    if (bucket) {
      buckets.push(bucket);
    } else {
      buckets = this.buckets;
    }
    const listResponse: ListResponse = {
      responses: [],
      operation_status: { code: 0, message: '' }
    };

    for (const bucket of buckets) {
      if (bucket != null) {
        const request: ListObjectsV2Request = { Bucket: bucket };
        if (max_keys) {
          request.MaxKeys = max_keys;
        }
        if (prefix) {
          request.Prefix = prefix;
        }
        let objList: any;
        try {
          objList = await new Promise((resolve, reject) => {
            this.ossClient.listObjectsV2(request, (err: any, data: any) => {
              if (err) {
                this.logger.error('Error occurred while listing objects',
                  {
                    bucket: request.Bucket, error: err, errorStack: err.stack
                  });
                reject(err);
              } else {
                return resolve(data.Contents);
              }
            });
          });
        } catch (err: any) {
          return {
            operation_status: {
              code: Number.isInteger(err?.code) ? err.code : 500,
              message: err?.message
            }
          };
        }

        if (objList != null && objList?.length > 0) {
          for (const eachObj of objList) {
            const headObjectParams = { Bucket: bucket, Key: eachObj.Key };
            const meta = await getHeadObject(headObjectParams, this.ossClient, this.logger);
            if (meta?.status) {
              return {
                operation_status: { code: meta.status.code, message: meta.status.message }
              };
            }
            const url = `//${bucket}/${eachObj.Key}`;
            const objectName = eachObj?.Key;
            let objectMeta;
            if (meta?.Metadata?.meta) {
              try {
                objectMeta = JSON.parse(meta.Metadata.meta);
              } catch (error) {
                this.logger.error('Error parsing object meta data in list endpoint', { code: error.code, message: error.message, stack: error.stack });
              }
              if (meta?.LastModified && objectMeta) {
                this.logger.debug('List api LastModified', { lastModified: meta?.LastModified });
                objectMeta.modified = new Date(meta.LastModified);
              }
            }
            const object = { object_name: objectName, url, meta: objectMeta };
            // authorization filter check
            if (this.cfg.get('authorization:enabled')) {
              // if target objects owners instance `ownerInst` is contained in the
              // list of applicable `ownerValues` returned from ACS ie. ownerValues.includes(ownerInst)
              // then its considred a match for further filtering based on filter field if it exists
              if (objectMeta?.owners?.length > 0) {
                for (const idVal of objectMeta.owners) {
                  if (idVal && idVal.id === ownerIndictaorEntURN && idVal.value === ownerIndicatorEntity && idVal.attributes?.length > 0) {
                    for (const ownInstObj of idVal.attributes) {
                      if (ownInstObj?.id === ownerInstanceURN && ownInstObj?.value && ownerValues.includes(ownInstObj.value)) {
                        this.filterObjects(filters, object, listResponse);
                      }
                    }
                  }
                }
                // no scoping defined in the Rule
                if (!ownerValues) {
                  listResponse.responses.push({
                    payload: object,
                    status: { id: objectName, code: 200, message: 'success' }
                  });
                }
              }
            } else {
              this.filterObjects(filters, object, listResponse);
            }
          }
        }
      }
    }
    listResponse.operation_status = OPERATION_STATUS_SUCCESS;
    return listResponse;
  }

  async* get(request: GetRequest, ctx: any): ServerStreamingMethodResult<DeepPartial<ObjectResponse>> {
    // get gRPC call request
    const { bucket, key, download } = request;
    let subject = request.subject;
    if (!subject) {
      subject = { id: '', scope: '', token: '', unauthenticated: undefined };
    }
    this.logger.info(`Received a request to get object ${key} on bucket ${bucket}`);
    if (!_.includes(this.buckets, bucket)) {
      yield {
        response: {
          payload: null,
          status: {
            id: key,
            code: 400,
            message: `Invalid bucket name ${bucket}`
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
      return;
    }
    if (!key) {
      yield {
        response: {
          payload: null,
          status: {
            id: key,
            code: 400,
            message: `Invalid key name ${key}`
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
      return;
    }

    // get metadata of the object stored in the S3 object storage
    const params = { Bucket: bucket, Key: key };
    const headObject: any = await getHeadObject(params, this.ossClient, this.logger);
    if (headObject?.status) {
      yield {
        response: {
          payload: null,
          status: {
            id: key,
            code: Number.isInteger(headObject?.status?.code) ? headObject.status.code : 500,
            message: headObject.status.message
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
      return;
    }

    // get object tagging of the object stored in the S3 object storage
    let objectTagging: any;
    try {
      objectTagging = await new Promise((resolve, reject) => {
        this.ossClient.getObjectTagging(params, async (err: any, data) => {
          if (err) {
            // map the s3 error codes to standard chassis-srv errors
            if (err.code === 'NotFound') {
              err = new errors.NotFound('Specified key does not exist');
              err.code = 404;
            }
            this.logger.error('Error occurred while retrieving object tag',
              {
                Key: key, error: err, errorStack: err.stack
              });
            reject(err);
          } else {
            resolve(data);
          }
        });
      });
    } catch (err: any) {
      this.logger.info('No object tagging found for key:', { Key: key });
      yield {
        response: {
          payload: null,
          status: {
            id: key,
            code: Number.isInteger(err?.code) ? err.code : 500,
            message: err?.message
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
      return;
    }
    // capture meta data from response message
    let metaObj: Meta;
    let data = {};
    let meta_subject = { id: '' };
    // headObject.LastModified -> will give you lastModified field add this to meta in response
    try {
      if (headObject?.Metadata) {
        if (headObject?.Metadata?.meta) {
          metaObj = JSON.parse(headObject.Metadata.meta);
          // restore ACL from redis into metaObj
          const acl = await this.aclRedisClient.get(`${bucket}:${key}`);
          if (acl) {
            metaObj.acls = JSON.parse(acl);
          }
        }
        if (headObject?.Metadata?.data) {
          data = JSON.parse(headObject.Metadata.data);
        }
        if (headObject?.Metadata?.subject) {
          meta_subject = JSON.parse(headObject.Metadata.subject);
        }
      }
    } catch (error) {
      this.logger.error('Error parsing Object meta data in get endpoint', { code: error.code, message: error.message, stack: error.stack });
    }

    // capture options from response headers
    // these options are added with the put method
    // with the help of the storeObject() which is
    // using the s3.upload() method
    let encoding, content_type, content_language, content_disposition, length, version, md5;
    if (headObject) {
      if (headObject.ContentEncoding) {
        encoding = headObject.ContentEncoding;
      }
      if (headObject.ContentType) {
        content_type = headObject.ContentType;
        if (headObject.ContentLanguage) {
          content_language = headObject.ContentLanguage;
        }
        // check download param
        if (download) {
          content_disposition = 'attachment';
        } else {
          content_disposition = 'inline';
        }
        if (headObject.ContentLength) {
          length = headObject.ContentLength;
        }
        if (headObject.ETag) {
          md5 = headObject.ETag;
        }
        if (headObject['x-amz-version-id']) {
          version = headObject['x-amz-version-id'];
        }
      }
      const tags: Attribute[] = [];
      if (objectTagging?.TagSet?.length > 0) {
        // transform received object to respect our own defined structure
        for (const tagObj of objectTagging.TagSet) {
          tags.push({
            id: tagObj.Key,
            value: tagObj.Value,
            attributes: []
          });
        }
      }

      const optionsObj: Options = { encoding, content_type, content_language, content_disposition, length, version, md5, tags };
      // Make ACS request with the meta object read from storage
      // When uploading files from the minio console the objects
      // have no meta stored so first check if meta is defined
      // before making the ACS request

      if (metaObj?.owners?.length > 0) {
        let metaOwnerVal;
        const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
        for (const owner of metaObj.owners) {
          if (owner?.attributes?.length > 0) {
            for (const ownerInstObj of owner.attributes) {
              if (ownerInstObj.id === ownerInstanceURN) {
                metaOwnerVal = ownerInstObj.value;
              }
            }
          }
        }
        // restore scope for acs check from metaObj owners
        subject.scope = metaOwnerVal;
      } else {
        this.logger.debug('Object does not contain owners information');
      }
      // resource identifier is key here
      const resource = { id: key, bucket, meta: metaObj, data, subject: { id: meta_subject.id } };
      let acsResponse: DecisionResponse; // isAllowed check for Read operation
      try {
        if (!ctx) { ctx = {}; };
        // target entity for ACS is bucket name here
        ctx.subject = subject;
        // setting ctx resources since for read operation we make isAllowed request
        ctx.resources = resource;
        acsResponse = await checkAccessRequest(ctx, [{ resource: bucket, id: key }], AuthZAction.READ,
          Operation.isAllowed);
      } catch (err: any) {
        this.logger.error('Error occurred requesting access-control-srv for get operation', err);
        yield {
          response: {
            payload: null,
            status: {
              id: key,
              code: acsResponse.operation_status.code,
              message: acsResponse.operation_status.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
        return;
      }
      if (acsResponse.decision != Response_Decision.PERMIT) {
        yield {
          response: {
            payload: null,
            status: {
              id: key,
              code: acsResponse.operation_status.code,
              message: acsResponse.operation_status.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
        return;
      }

      // retrieve object from Amazon S3
      // and create stream from it
      const downloadable = this.ossClient.getObject({ Bucket: bucket, Key: key }).createReadStream();
      if (headObject?.LastModified && metaObj) {
        this.logger.debug('GET api LastModified', { lastModified: headObject?.LastModified });
        metaObj.modified = new Date(headObject.LastModified);
      }

      if (metaObj?.created && typeof metaObj.created === 'string') {
        metaObj.created = new Date(metaObj.created);
      }

      try {
        for await (const chunk of downloadable) {
          yield {
            response: {
              payload: { bucket, key, object: chunk, url: `//${bucket}/${key}`, options: optionsObj, meta: metaObj },
              status: {
                id: key,
                code: 200,
                message: 'success'
              }
            }
          };
        }
      } catch (err: any) {
        this.logger.error('Error piping streamable response', { err: err.messsage });
        const code = (err as any).code || 500;
        yield {
          response: {
            payload: null,
            status: {
              id: key,
              code,
              message: err?.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      }
      this.logger.info(`S3 read stream ended and Object ${key} download from ${bucket} bucket successful`);
      // emit objectDownloadRequested event
      // collect all metadata
      const allMetadata = {
        optionsObj,
        metaObj,
        data,
        meta_subject
      };

      if (this.topics && this.topics['ostorage']) {
        // update downloader subject scope from findByToken with default_scope
        if (subject?.token) {
          const dbSubject = await this.idsService.findByToken({ token: subject.token });
          subject.scope = dbSubject?.payload?.default_scope;
        }
        const objectDownloadRequestPayload = {
          key,
          bucket,
          metadata: marshallProtobufAny(allMetadata),
          subject
        };
        this.topics['ostorage'].emit('objectDownloadRequested', objectDownloadRequestPayload);
        this.logger.info('Emitted Event objectDownloadRequested successfully', objectDownloadRequestPayload);
      }
      return;
    }
  }

  /**
   * creates meta object containing owners information
   * @param reaources resource
   * @param orgKey orgKey
   */
  private createMetadata(resource: any, subject: Subject): any {
    let targetScope;
    if (!_.isEmpty(subject)) {
      targetScope = subject.scope;
    }
    const ownerAttributes: Attribute[] = [];
    const urns = this.cfg.get('authorization:urns');
    if (targetScope) {
      ownerAttributes.push(
        {
          id: urns?.ownerIndicatoryEntity,
          value: urns?.organization,
          attributes: [{
            id: urns?.ownerInstance,
            value: targetScope
          }]
        });
    }

    if (_.isEmpty(resource.meta)) {
      resource.meta = {};
    }
    if (_.isEmpty(resource?.meta?.owners)) {
      resource.meta.owners = ownerAttributes;
    }
    resource.meta.created_by = subject?.id;
    resource.meta.modified_by = subject?.id;
    return resource;
  }

  async put(request: AsyncIterable<PutObject>, ctx: any): Promise<DeepPartial<PutResponse>> {
    let key, bucket, meta, options, subject;
    const readable = new Readable({ read() { } });
    for await (const item of request) {
      readable.push(item.object);
      if (!bucket || !key) {
        bucket = item.bucket;
        key = item.key;
        options = item.options;
        subject = item.subject;
        meta = item.meta;
        this.logger.info(`Received a request to put object ${key} on bucket ${bucket}`);
      }
    }
    readable.push(null);
    try {
      if (!_.includes(this.buckets, bucket)) {
        return {
          response: {
            payload: null,
            status: {
              id: key,
              code: 400,
              message: `Invalid bucket name ${bucket}`
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      }

      // added resource id as key - needed for ctx resources HR scope check
      let resource = { id: key, key, bucket, meta, options, subject: { id: subject.id } };
      resource = this.createMetadata(resource, subject);
      const metaWithOwner = resource.meta;
      if (metaWithOwner) {
        metaWithOwner.modified = new Date();
      }
      // created meta if it was not provided in request
      let acsResponse: DecisionResponse;
      try {
        if (!ctx) { ctx = {}; };
        ctx.subject = subject;
        ctx.resources = resource;
        // target entity for ACS is bucket name here
        acsResponse = await checkAccessRequest(ctx, [{ resource: bucket, id: key }], AuthZAction.CREATE,
          Operation.isAllowed) as DecisionResponse;
      } catch (err: any) {
        this.logger.error('Error occurred requesting access-control-srv for put operation', err);
        return {
          response: {
            payload: null,
            status: {
              id: key,
              code: Number.isInteger(err?.code) ? err.code : 500,
              message: err?.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      }
      if (acsResponse.decision != Response_Decision.PERMIT) {
        return {
          response: {
            status: {
              id: key,
              code: acsResponse.operation_status?.code ?? 500,
              message: acsResponse.operation_status?.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      }
      let subjectID = '';
      if (subject?.token) {
        const dbSubject = await this.idsService.findByToken({ token: subject.token });
        subjectID = dbSubject?.payload?.id;
      }
      if (subject?.id) {
        subjectID = subject.id;
      }
      const response = await this.storeObject(
        key,
        bucket,
        readable, // readable stream
        metaWithOwner,
        options,
        subjectID
      );
      return response;
    } catch (e: any) {
      this.logger.error('Error occurred while storing object.', e);
      return {
        response: {
          payload: null,
          status: {
            id: key,
            code: Number.isInteger(e?.code) ? e.code : 500,
            message: e?.message
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
  }

  private async storeObject(key: string, bucket: string, readable: Readable, meta: Meta,
    options: Options, subjectID: string): Promise<PutResponse> {
    this.logger.info('Received a request to store Object:', { Key: key, Bucket: bucket });
    try {
      let data = {};
      if (options?.data) {
        data = unmarshallProtobufAny(options.data, this.logger);
      }
      let subject = {};
      if (subjectID) {
        subject = { id: subjectID };
      }

      const metaDataCopy = {
        meta,
        data,
        subject
      };
      // Only Key Value pairs where the Values must be strings can be stored
      // inside the object metadata in S3, reason why we stringify the value fields.
      // When sending over Kafka we send metadata as google.protobuf.Any,
      // so we create a copy of the metaData object in unstringified state
      if (meta?.acls && !_.isEmpty(meta.acls)) {
        // store meta acl to redis
        await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(meta.acls));
        delete meta.acls;
      }

      const metaData = {
        meta: JSON.stringify(meta),
        data: JSON.stringify(data),
        subject: JSON.stringify(subject)
      };

      // get object length
      const length = readable.readableLength;

      // convert array of tags to query parameters
      // required by AWS S3
      let TaggingQueryParams = '';
      let tagId: string, tagVal: string;
      if (options && options.tags) {
        const tags = options.tags;
        for (const [i, v] of (tags as any).entries()) {
          tagId = v.id;
          tagVal = v.value;
          if (i < tags.length - 1) {
            TaggingQueryParams += tagId + '=' + tagVal + '&';
          } else {
            TaggingQueryParams += tagId + '=' + tagVal;
          }
        }
      }
      // write headers to the S3 object
      if (!options) {
        options = { encoding: '', content_type: '', length: 0, content_disposition: '', version: '', content_language: '', md5: '', tags: [] };
      }
      const result: any = await new Promise((resolve, reject) => {
        this.ossClient.upload({
          Key: key,
          Bucket: bucket,
          Body: readable,
          Metadata: metaData,
          // options:
          ContentEncoding: options.encoding,
          ContentType: options.content_type,
          ContentLanguage: options.content_language,
          ContentDisposition: options.content_disposition,
          Tagging: TaggingQueryParams // this param looks like 'key1=val1&key2=val2'
        }, (err: any, data: any) => {
          if (err) {
            this.logger.error('Error occurred while storing object',
              {
                Key: key, Bucket: bucket, error: err, errStack: err.stack
              });
            return {
              response: {
                status: {
                  id: key,
                  code: Number.isInteger(err?.code) ? err.code : 500,
                  message: err?.message
                }
              },
              operation_status: OPERATION_STATUS_SUCCESS
            };
          } else {
            resolve(data);
          }
        });
      });



      if (result) {
        if (this.topics && this.topics['ostorage']) {
          // emit objectUploaded event
          const objectUploadedPayload = {
            key,
            bucket,
            metadata: marshallProtobufAny(metaDataCopy),
            subject: { id: subjectID }
          };
          this.topics['ostorage'].emit('objectUploaded', objectUploadedPayload);
        }
        // instead of bucket and key use the result to construct the URL if it exists
        let bucketWithKey;
        if (result?.Location) {
          const uploadedUrl = result?.Location;
          bucketWithKey = uploadedUrl?.substring(uploadedUrl?.indexOf(bucket));
        }
        const url = bucketWithKey ? `//${bucketWithKey}` : `//${bucket}/${key}`;
        const tags = options && options.tags;
        this.logger.info(`Object ${key} uploaded successfully to bucket ${bucket}`, { url });
        return {
          response: {
            payload: { key, bucket, url, meta, tags, length },
            status: { id: key, code: 200, message: 'success' }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      } else {
        this.logger.error('No output returned when trying to store object',
          {
            Key: key, Bucket: bucket
          });
      }
    } catch (err: any) {
      this.logger.error('Error storing object', err);
      return {
        response: {
          payload: null,
          status: { id: key, code: Number.isInteger(err?.code) ? err.code : 500, message: err?.message }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
  }

  async move(request: MoveRequestList, context?: any): Promise<DeepPartial<MoveResponseList>> {
    const { items, subject } = request;
    this.logger.info('Received a request to Move Object', { items: request.items });
    const moveResponse: MoveResponseList = {
      responses: [],
      operation_status: { code: 0, message: '' }
    };
    if (_.isEmpty(items)) {
      moveResponse.operation_status = { code: 400, message: 'Items missing in request' };
      return moveResponse;
    }

    for (const item of items) {
      let sourceBucketName, sourceKeyName;
      if (item.sourceObject) {
        (item as any).copySource = item.sourceObject;
        const copySource = item.sourceObject;
        let copySourceStr = copySource;
        if (copySource.startsWith('/')) {
          copySourceStr = copySource.slice(1, copySource.length);
        }
        sourceBucketName = copySourceStr.substring(0, copySourceStr.indexOf('/'));
        sourceKeyName = copySourceStr.substr(copySourceStr.indexOf('/') + 1, copySourceStr.length);
      }
      // No need for ACS check as both Read and Create access check are made in Copy operation
      const copyResponse = await this.copy({ items: [item as any], subject }, context);
      // if copyResponse is success for each of the object then delete the sourceObject
      if (copyResponse?.operation_status?.code === 200 && copyResponse?.responses?.length > 0) {
        for (const response of copyResponse.responses) {
          if (response?.status?.code === 200) {
            // delete sourceObject Object
            const payload = response?.payload;
            const deleteResponse = await this.delete({
              bucket: sourceBucketName, key: sourceKeyName, subject
            } as any, context);
            let deleteResponseCode, deleteResponseMessage;
            if (deleteResponse?.status && deleteResponse.status[0]) {
              deleteResponseCode = deleteResponse.status[0].code;
              deleteResponseMessage = deleteResponse.status[0].message;
            }

            if (deleteResponseCode === 200) {
              if (response.payload.copySource) {
                (response.payload as any).sourceObject = response.payload.copySource;
                delete response.payload.copySource;
              }
              moveResponse.responses.push({
                payload: (response.payload as any),
                status: {
                  id: payload.key,
                  code: deleteResponse.status[0].code,
                  message: deleteResponse.status[0].message
                }
              });
            } else {
              // fail status
              moveResponse.responses.push({
                status: {
                  id: payload.key,
                  code: deleteResponseCode,
                  message: deleteResponseMessage
                }
              });
            }
          } else {
            // fail status
            moveResponse.responses.push({
              status: {
                id: response?.status?.id,
                code: response?.status?.code,
                message: response?.status?.message
              }
            });
          }
        }
      } else {
        moveResponse.operation_status = { code: copyResponse.operation_status.code, message: copyResponse.operation_status.message };
      }
    }
    moveResponse.operation_status = { code: 200, message: 'success' };
    this.logger.info('Move Object response', moveResponse);
    return moveResponse;
  }

  async copy(request: CopyRequestList, ctx: any): Promise<DeepPartial<CopyResponseList>> {
    let bucket: string;
    let copySource: string;
    let key: string;
    let meta: Meta;
    let options: Options;
    const grpcResponse: CopyResponseList = { responses: [], operation_status: { code: 0, message: '' } };
    let copyObjectResult;
    let subject = request.subject;
    let destinationSubjectScope; // scope for destination bucket
    if (subject?.scope) {
      destinationSubjectScope = subject.scope;
    }
    this.logger.info('Received a request to Copy Object', { items: request.items });
    if (request?.items?.length > 0) {
      for (const item of request.items) {
        bucket = item?.bucket;
        copySource = item?.copySource;
        key = item?.key;
        meta = item?.meta;
        if (!meta) {
          (meta as any) = {};
        }
        options = item.options;

        // Regex to extract bucket name and key from copySource
        // ex: copySource= /bucketName/sample-directory/objectName.txt
        if (!copySource) {
          grpcResponse.responses.push({
            status: {
              id: key,
              code: 400,
              message: 'missing source path for copy operation'
            }
          });
          continue;
        }
        let copySourceStr = copySource;
        if (copySource.startsWith('/')) {
          copySourceStr = copySource.slice(1, copySource.length);
        }
        const sourceBucketName = copySourceStr.substring(0, copySourceStr.indexOf('/'));
        const sourceKeyName = copySourceStr.substring(copySourceStr.indexOf('/') + 1, copySourceStr.length);
        // Start - Compose the copyObject params
        const params: CopyObjectParams = {
          Bucket: bucket,
          CopySource: copySource,
          Key: key
        };

        const headObjectParams = { Bucket: sourceBucketName, Key: sourceKeyName };
        const headObject: any = await getHeadObject(headObjectParams, this.ossClient, this.logger);
        if (headObject?.LastModified) {
          this.logger.debug('Copy api last modified', { lastModified: headObject?.LastModified });
          meta.modified = new Date(headObject?.LastModified);
        }
        if (headObject?.status) {
          grpcResponse.responses.push({
            status: {
              id: sourceKeyName,
              code: Number.isInteger(headObject?.status?.code) ? headObject.status.code : 500,
              message: headObject.status.message
            }
          });
          continue;
        }
        let metaObj: Meta;
        let data = {};
        let meta_subject = { id: '' };
        try {
          if (headObject?.Metadata) {
            if (headObject.Metadata.meta) {
              metaObj = JSON.parse(headObject.Metadata.meta);
              // restore ACL from redis into metaObj
              let redisKey;
              if (sourceKeyName.startsWith('/')) {
                redisKey = sourceKeyName.substring(1);
              } else {
                redisKey = sourceKeyName;
              }
              const acl = await this.aclRedisClient.get(`${sourceBucketName}:${redisKey}`);
              if (acl) {
                metaObj.acls = JSON.parse(acl);
              }
            }
            if (headObject.Metadata.data) {
              data = JSON.parse(headObject.Metadata.data);
            }
            if (headObject.Metadata.subject) {
              meta_subject = JSON.parse(headObject.Metadata.subject);
            }
          }
        } catch (err: any) {
          const status: Status = {
            code: Number.isInteger(err?.code) ? err.code : 500,
            message: err.message,
          };
          this.logger.error('Error parsing object meta data in copy endpoint', {
            status,
            stack: err.stack
          });
          grpcResponse.responses.push({
            status
          });
        }
        if (!subject) {
          subject = { id: '', unauthenticated: undefined, scope: '', token: '' };
        }
        if (metaObj?.owners?.length > 0) {
          let metaOwnerVal;
          const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
          for (const owner of metaObj.owners) {
            if (owner?.attributes?.length > 0) {
              for (const ownerInstObj of owner.attributes) {
                if (ownerInstObj.id === ownerInstanceURN) {
                  metaOwnerVal = ownerInstObj.value;
                }
              }
            }
          }
          // restore scope for acs check from metaObj owners
          subject.scope = metaOwnerVal;
        }

        // ACS read request check for source Key READ and CREATE action request check for destination Bucket
        const resource = { id: key, key, sourceBucketName, meta: metaObj, data, subject: { id: meta_subject.id } };
        let acsResponse: DecisionResponse; // isAllowed check for Read operation
        try {
          if (!ctx) { ctx = {}; };
          // target entity for ACS is source bucket here
          ctx.subject = subject;
          ctx.resources = resource;
          acsResponse = await checkAccessRequest(ctx, [{ resource: sourceBucketName, id: key }], AuthZAction.READ,
            Operation.isAllowed);
        } catch (err: any) {
          this.logger.error('Error occurred requesting access-control-srv for copy read', err);
          grpcResponse.responses.push({
            status: {
              id: sourceKeyName,
              code: Number.isInteger(err?.code) ? err.code : 500,
              message: err?.message
            }
          });
          continue;
        }
        if (acsResponse.decision != Response_Decision.PERMIT) {
          grpcResponse.responses.push({
            status: {
              id: sourceKeyName,
              code: acsResponse.operation_status.code || 500,
              message: acsResponse.operation_status.message
            }
          });
          continue;
        }

        // check write access to destination bucket
        subject.scope = destinationSubjectScope;
        // target entity for ACS is destination bucket here
        // For Create ACS check use the meta ACL as passed from the subject
        if (metaObj == undefined) {
          metaObj = { acls: [] };
        }
        const sourceACL = metaObj.acls;
        metaObj.acls = meta?.acls ? meta.acls : [];
        resource.meta = metaObj;
        if (!ctx) { ctx = {}; };
        ctx.subject = subject;
        ctx.resources = resource;
        const writeAccessResponse = await checkAccessRequest(ctx, [{ resource: bucket, id: resource.key }],
          AuthZAction.CREATE, Operation.isAllowed);
        if (writeAccessResponse.decision != Response_Decision.PERMIT) {
          grpcResponse.responses.push({
            status: {
              id: key,
              code: writeAccessResponse.operation_status.code || 500,
              message: writeAccessResponse.operation_status.message
            }
          });
          continue;
        }

        const optionsExist = Object.values(options ?? {}).some(
          o => o !== undefined
        );

        // CASE 1: User provides at least one option => replace all obj meta including tagging
        if (optionsExist) {
          params.MetadataDirective = 'REPLACE';
          params.TaggingDirective = 'REPLACE';

          // 1. Add user defined Metadata if its not provided
          if (!meta) {
            meta = {} as any;
          }
          if (_.isEmpty(meta.owners)) {
            const urns = this.cfg.get('authorization:urns');
            meta.owners = [{
              id: urns.ownerIndicatoryEntity,
              value: urns.organization,
              attributes: [{
                id: urns.ownerInstance,
                value: destinationSubjectScope,
                attributes: []
              }]
            }];
          }
          if (meta && meta.acls && !_.isEmpty(meta.acls)) {
            // store meta acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(meta.acls));
            delete meta.acls;
          } else if (sourceACL && !_.isEmpty(sourceACL)) {
            // store source acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(sourceACL));
          }
          params.Metadata = {
            meta: JSON.stringify(meta),
            subject: JSON.stringify({ id: subject.id })
          };
          // override data if it is provided
          if (options?.data) {
            // params.Metadata.data = JSON.stringify(options.data);
            params.Metadata.data = JSON.stringify(unmarshallProtobufAny(options.data, this.logger));
          } else {
            params.Metadata.data = JSON.stringify(data);
          }

          // 2. Add object metadata if provided
          // ContentEncoding
          if (!_.isEmpty(options?.encoding)) {
            params.ContentEncoding = options.encoding;
          }
          // ContentType
          if (!_.isEmpty(options?.content_type)) {
            params.ContentType = options.content_type;
          }
          // ContentLanguage
          if (!_.isEmpty(options?.content_language)) {
            params.ContentLanguage = options.content_language;
          }
          // ContentDisposition
          if (!_.isEmpty(options?.content_disposition)) {
            params.ContentDisposition = options.content_disposition;
          }

          // 3. Add Tagging if provided [ first convert array of tags to query parameters (it is required by S3) ]
          let TaggingQueryParams = '';
          let tagId: string, tagVal: string;
          if (!_.isEmpty(options?.tags)) {
            const tagsList = options.tags;
            for (const [i, v] of (tagsList as any).entries()) {
              tagId = v.id;
              tagVal = v.value;
              if (i < options.tags.length - 1) {
                TaggingQueryParams += tagId + '=' + tagVal + '&';
              } else {
                TaggingQueryParams += tagId + '=' + tagVal;
              }
            }
          }
          if (!_.isEmpty(TaggingQueryParams)) {
            params.Tagging = TaggingQueryParams;
          }

          // End - Compose the copyObject params

          // 4. Copy object with new metadata
          try {
            copyObjectResult = await new Promise((resolve, reject) => {
              if (this.keyContainsSpecialCharacters(params.CopySource)) {
                params.CopySource = encodeURIComponent(params.CopySource);
              }
              this.ossClient.copyObject(params, async (err: any, data) => {
                if (err) {
                  this.logger.error('Error occurred while copying object:',
                    {
                      Bucket: bucket, Key: key, error: err, errorStack: err.stack
                    });
                  reject(err);
                } else {
                  const eTag = data.CopyObjectResult.ETag;
                  const lastModified = data.CopyObjectResult.LastModified;
                  this.logger.info('Copy object successful!', {
                    Bucket: bucket, Key: key, ETag: eTag, LastModified: lastModified
                  });
                  resolve(data);
                }
              });
            });
          } catch (err: any) {
            grpcResponse.responses.push({
              status: {
                id: key,
                code: Number.isInteger(err?.code) ? err.code : 500,
                message: err?.message
              }
            });
          }
        } else {

          // CASE 2: No options provided => copy the object as it is and update user defined metadata (owners)

          // 1. Add user defined Metadata if its not provided
          params.MetadataDirective = 'REPLACE';
          if (!meta) {
            meta = {} as any;
          }
          if (_.isEmpty(meta.owners)) {
            const urns = this.cfg.get('authorization:urns');
            meta.owners = [{
              id: urns?.ownerIndicatoryEntity,
              value: urns?.organization,
              attributes: [{
                id: urns?.ownerInstance,
                value: destinationSubjectScope
              }]
            }];
          }
          if (meta && meta.acls && !_.isEmpty(meta.acls)) {
            // store meta acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(meta.acls));
            delete meta.acls;
          } else if (sourceACL && !_.isEmpty(sourceACL)) {
            // store source acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(sourceACL));
          }
          params.Metadata = {
            data: JSON.stringify(data),
            meta: JSON.stringify(meta),
            subject: JSON.stringify({ id: subject.id })
          };

          // 2. Add Object metadata
          if (headObject) {
            // ContentEncoding
            if (headObject.ContentEncoding && !_.isEmpty(headObject.ContentEncoding)) {
              params.ContentEncoding = headObject.ContentEncoding;
            }
            // ContentType
            if (headObject.ContentType && !_.isEmpty(headObject.ContentType)) {
              params.ContentType = headObject.ContentType;
            }
            // ContentLanguage
            if (headObject.ContentLanguage && !_.isEmpty(headObject.ContentLanguage)) {
              params.ContentLanguage = headObject.ContentLanguage;
            }
            // ContentDisposition
            if (headObject.ContentDisposition && !_.isEmpty(headObject.ContentDisposition)) {
              params.ContentDisposition = headObject.ContentDisposition;
            }
          }

          // 3. Add Tagging
          // Get the source object's existing tagging and add it to our object
          const objectTagging: any = await new Promise((resolve, reject) => {
            this.ossClient.getObjectTagging(headObjectParams, async (err: any, data) => {
              if (err) {
                this.logger.error('Error occurred while retrieving tagging for object:',
                  {
                    Bucket: sourceBucketName, Key: sourceKeyName, error: err, errorStack: err.stack
                  });
                resolve(err); // resolve if err, this does not stop the service when tagging not found
              } else {
                resolve(data);
              }
            });
          });
          if (objectTagging && !_.isEmpty(objectTagging.TagSet)) {
            // first convert array of tags to query parameters (it is required by S3)
            let TaggingQueryParams = '';
            let tagId: string, tagVal: string;
            const tagsList = objectTagging.TagSet;
            for (const [i, v] of tagsList.entries()) {
              tagId = v.Key;
              tagVal = v.Value;
              if (i < tagsList.length - 1) {
                TaggingQueryParams += tagId + '=' + tagVal + '&';
              } else {
                TaggingQueryParams += tagId + '=' + tagVal;
              }
            }
            if (!_.isEmpty(TaggingQueryParams)) {
              params.TaggingDirective = 'REPLACE';
              params.Tagging = TaggingQueryParams;
            }
          }

          // End - Compose the copyObject params

          // 4. Copy object with new metadata
          try {
            copyObjectResult = await new Promise((resolve, reject) => {
              if (this.keyContainsSpecialCharacters(params.CopySource)) {
                params.CopySource = encodeURIComponent(params.CopySource);
              }
              this.ossClient.copyObject(params, async (err: any, data) => {
                if (err) {
                  this.logger.error('Error occurred while copying object:',
                    {
                      Bucket: bucket, Key: key, error: err, errorStack: err.stack
                    });
                  reject(err);
                } else {
                  const eTag = data.CopyObjectResult.ETag;
                  const lastModified = data.CopyObjectResult.LastModified;
                  this.logger.info('Copy object successful', {
                    Bucket: bucket, Key: key, ETag: eTag, LastModified: lastModified
                  });
                  resolve(data);
                }
              });
            });
          } catch (err: any) {
            const status: Status = {
              code: Number.isInteger(err?.code) ? err.code : 500,
              message: err?.message
            };
            this.logger.error('Error copying object', status, err.stack);
            grpcResponse.responses.push({
              status
            });
          }
        }

        if (copyObjectResult) {
          const copiedObject: CopyResponseItem = {
            bucket,
            copySource,
            key,
            meta,
            options
          };
          grpcResponse.responses.push({ payload: copiedObject, status: { id: key, code: 200, message: 'success' } });
        } else {
          this.logger.error('Copy object failed for:', { DestinationBucket: bucket, CopySource: copySource, Key: key, Meta: meta, Options: options });
        }
      }
    }
    grpcResponse.operation_status = { code: 200, message: 'success' };
    this.logger.info('Copy Object response', grpcResponse);
    return grpcResponse;
  }

  // Regular expression that checks if the filename string contains
  // only characters described as safe to use in the Amazon S3
  // Object Key Naming Guidelines
  private keyContainsSpecialCharacters(key: string): boolean {
    const allowedCharacters = new RegExp('^[a-zA-Z0-9-!_.*\'()@/]+$');
    if (allowedCharacters.test(key) === true) {
      return false;
    } else {
      return true;
    }
  }

  async delete(request: DeleteRequest, ctx: any): Promise<DeepPartial<DeleteResponse>> {
    const { bucket, key } = request;
    const subject = request.subject;
    if (!_.includes(this.buckets, bucket)) {
      return {
        status: [{ id: key, code: 400, message: `Invalid bucket name ${bucket}` }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }

    this.logger.info(`Received a request to delete object ${key} on bucket ${bucket}`);
    const resources = { Bucket: bucket, Key: key };
    const headObject: any = await getHeadObject(resources, this.ossClient, this.logger);
    if (headObject?.status) {
      return {
        status: [{ id: key, code: Number.isInteger(headObject?.status?.code) ? headObject.status.code : 500, message: headObject.status.message }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
    // capture meta data from response message
    let metaObj: Meta;
    let data = {};
    let meta_subject = { id: '' };
    try {
      if (headObject?.Metadata) {
        if (headObject.Metadata.meta) {
          metaObj = JSON.parse(headObject.Metadata.meta);
          // restore ACL from redis into metaObj
          const acl = await this.aclRedisClient.get(`${bucket}:${key}`);
          if (acl) {
            metaObj.acls = JSON.parse(acl);
          }
        }
        if (headObject.Metadata.data) {
          data = JSON.parse(headObject.Metadata.data);
        }
        if (headObject.Metadata.subject) {
          meta_subject = JSON.parse(headObject.Metadata.subject);
        }
      }
    } catch (error) {
      this.logger.error('Error parsing object meta data in delete endpoint', { code: error.code, message: error.message, stack: error.stack });
    }
    Object.assign(resources, { meta: metaObj, data, subject: { id: meta_subject.id } });
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      if (!(resources as any).id) {
        (resources as any).id = key;
      }
      ctx.resources = resources;
      acsResponse = await checkAccessRequest(ctx, [{ resource: bucket, id: key }], AuthZAction.DELETE,
        Operation.isAllowed);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv for delete operation:', err);
      return {
        status: [{
          id: key,
          code: Number.isInteger(err?.code) ? err.code : 500,
          message: err?.message
        }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return {
        status: [{ id: key, code: acsResponse.operation_status.code, message: acsResponse.operation_status.message }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }

    const result = await this.ossClient.deleteObject({
      Bucket: bucket,
      Key: key
    }).promise();

    if (result.$response.error) {
      this.logger.error(`Error while deleting object ${key} from bucket ${bucket}`, {
        error: result.$response.error
      });
      return {
        status: [{ id: key, code: 500, message: result.$response.error.message }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
    this.logger.info(`Successfully deleted object ${key} from bucket ${bucket}`);
    // delete ACL key from redis if it exists
    const acl = await this.aclRedisClient.get(`${bucket}:${key}`);
    if (acl) {
      await this.aclRedisClient.del(`${bucket}:${key}`);
      this.logger.info(`ACL data for ${bucket}:${key} key successfully deleted from redis`);
    }
    return {
      status: [{ id: key, code: 200, message: 'success' }],
      operation_status: OPERATION_STATUS_SUCCESS
    };
  }

  /**
   *  disable access control
   */
  disableAC() {
    try {
      this.cfg.set('authorization:enabled', false);
      updateConfig(this.cfg);
    } catch (err: any) {
      this.logger.error('Error caught disabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  /**
   *  enables access control
   */
  enableAC() {
    try {
      this.cfg.set('authorization:enabled', true);
      updateConfig(this.cfg);
    } catch (err: any) {
      this.logger.error('Error caught enabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  /**
   *  restore AC state to previous vale either before enabling or disabling AC
   */
  restoreAC() {
    try {
      this.cfg.set('authorization:enabled', this.authZCheck);
      updateConfig(this.cfg);
    } catch (err: any) {
      this.logger.error('Error caught enabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }
}
