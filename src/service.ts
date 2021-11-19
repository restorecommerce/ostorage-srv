import * as _ from 'lodash';
import * as aws from 'aws-sdk';
import { Readable, Transform } from 'stream';
import { errors } from '@restorecommerce/chassis-srv';
import {
  checkAccessRequest, unmarshallProtobufAny,
  marshallProtobufAny, ReadPolicyResponse, getHeadObject
} from './utils';
import {
  Decision, AuthZAction, ACSAuthZ,
  Subject, updateConfig, DecisionResponse
} from '@restorecommerce/acs-client';
import {
  Attribute, Options, ListRequest, DeleteRequest, Call, PutResponse,
  CopyResponse, CopyResponseList, CopyObjectParams, Meta, DeleteResponse,
  ListResponse, MoveRequestList, MoveResponseList, MoveResponse
} from './interfaces';
import { Redis } from 'ioredis';
import { ListObjectsV2Request } from 'aws-sdk/clients/s3';

const META_OWNER = 'meta.owner';
const EQ = 'eq';

const OPERATION_STATUS_SUCCESS = {
  code: 200,
  message: 'success'
};

export class Service {
  ossClient: aws.S3; // object storage frameworks are S3-compatible
  buckets: string[];
  bucketsLifecycleConfigs?: any;
  authZ: ACSAuthZ;
  cfg: any;
  authZCheck: boolean;
  idsService: any;
  aclRedisClient: Redis;

  constructor(cfg: any, private logger: any, private topics: any, authZ: ACSAuthZ,
    idsService: any, aclRedisClient: Redis) {
    this.ossClient = new aws.S3(cfg.get('s3:client'));
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
    for (let bucket of this.buckets) {
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
    let existingBucketRules = [];
    // bucket names for which the existing rules should be deleted
    let deleteBucketRules = [];
    // bucket names for the rules in configuration
    let updateBucketRules = [];

    for (let bucket of this.buckets) {
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
            if (data && data.Rules) {
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
      for (let bucketLifecycleConfiguration of this.bucketsLifecycleConfigs) {
        updateBucketRules.push(bucketLifecycleConfiguration.Bucket);
      }

      for (let existingBucketRule of existingBucketRules) {
        if (!updateBucketRules.includes(existingBucketRule)) {
          deleteBucketRules.push(existingBucketRule);
        }
      }

      // delete rules
      for (let bucket of deleteBucketRules) {
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
      for (let bucketLifecycleParams of this.bucketsLifecycleConfigs) {
        let bucketName = bucketLifecycleParams.Bucket;
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
      for (let existingBucketRule of existingBucketRules) {
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
    if (requestFilter && requestFilter?.filter && !_.isEmpty(requestFilter?.filter)) {
      const filter = requestFilter.filter[0];
      if (filter && filter.field == META_OWNER && filter.operation == EQ && filter.value) {
        let metaOwnerVal;
        const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
        if (object && object.meta && object.meta.owner && _.isArray(object.meta.owner)) {
          for (let idVal of object.meta.owner) {
            if (idVal.id === ownerInstanceURN) {
              metaOwnerVal = idVal.value;
            }
          }
          // check only for the files matching the requested Owner Organizations
          if (filter.value == metaOwnerVal) {
            listResponse.response.push({
              payload: object,
              status: { id: object.object_name, code: 200, message: 'success' }
            });
          }
        }
      }
    } else { // else return all data
      listResponse.response.push({
        payload: object,
        status: { id: object.object_name, code: 200, message: 'success' }
      });
    }
  }

  async list(call: Call<ListRequest>, context?: any): Promise<ListResponse> {
    let { bucket, filters, max_keys, prefix } = call.request;

    let subject = call.request.subject;
    let resource: any = { bucket, filters };
    let acsResponse: ReadPolicyResponse; // WhatisAllowed check for Read operation
    try {
      // target entity for ACS is bucket name here
      Object.assign(resource, { subject });
      acsResponse = await checkAccessRequest(subject, resource, AuthZAction.READ,
        bucket, this, null, true);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    const customArgs = resource.custom_arguments;
    const ownerIndictaorEntURN = this.cfg.get('authorization:urns:ownerIndicatoryEntity');
    const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
    let customArgsFilter, ownerValues, ownerIndicatorEntity;
    if (customArgs && customArgs.value) {
      customArgsFilter = JSON.parse(customArgs.value.toString());
      // applicable target owner instances
      ownerValues = customArgsFilter.instance;
      ownerIndicatorEntity = customArgsFilter.entity;
    }

    let buckets = [];
    if (bucket) {
      buckets.push(bucket);
    } else {
      buckets = this.buckets;
    }
    let listResponse: ListResponse = {
      response: [],
      operation_status: { code: 0, message: '' }
    };

    for (const bucket of buckets) {
      if (bucket != null) {
        let request: ListObjectsV2Request = { Bucket: bucket };
        if (max_keys) {
          request.MaxKeys = max_keys;
        }
        if (prefix) {
          request.Prefix = prefix;
        }
        let objList: any;
        try {
          objList = await new Promise((resolve, reject) => {
            this.ossClient.listObjectsV2(request, (err, data) => {
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
        } catch (err) {
          return {
            operation_status: { code: err.code, message: err.message }
          };
        }

        if (objList != null) {
          for (let eachObj of objList) {
            const headObjectParams = { Bucket: bucket, Key: eachObj.Key };
            let meta: any;
            meta = await getHeadObject(headObjectParams, this.ossClient, this.logger);
            if (meta && meta.status) {
              return {
                operation_status: { code: meta.status.code, message: meta.status.message }
              };
            }
            const metaKey = meta?.Metadata?.key;
            const url = `//${bucket}/${metaKey}`;
            const objectName = metaKey;
            let objectMeta;
            if (meta && meta.Metadata && meta.Metadata.meta) {
              objectMeta = JSON.parse(meta.Metadata.meta);
            }
            let object = { object_name: objectName, url, meta: objectMeta };
            // authorization filter check
            if (this.cfg.get('authorization:enabled')) {
              // if target objects owner instance `ownerInst` is contained in the
              // list of applicable `ownerValues` returned from ACS ie. ownerValues.includes(ownerInst)
              // then its considred a match for further filtering based on filter field if it exists
              let match = false;
              let ownerInst;
              if (objectMeta && objectMeta.owner) {
                for (let idVal of objectMeta.owner) {
                  if (idVal.id === ownerIndictaorEntURN && idVal.value === ownerIndicatorEntity) {
                    match = true;
                  }
                  if (idVal.id === ownerInstanceURN) {
                    ownerInst = idVal.value;
                  }
                }
                if (match && ownerInst && ownerValues.includes(ownerInst)) {
                  this.filterObjects(filters, object, listResponse);
                }
                // no scoping defined in the Rule
                if (!ownerValues) {
                  listResponse.response.push({
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

  async get(call: any, context?: any): Promise<any> {
    // get gRPC call request
    const { bucket, key, download } = call.request.request;
    let subject = call.request.request.subject;
    if (!subject) {
      subject = {};
    }

    if (!_.includes(this.buckets, bucket)) {
      await call.write({
        response: {
          payload: null,
          status: {
            id: key,
            code: 400,
            message: `Invalid bucket name ${bucket}`
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      });
      return await call.end();
    }
    if (!key) {
      await call.write({
        response: {
          payload: null,
          status: {
            id: key,
            code: 400,
            message: `Invalid key name ${key}`
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      });
      return await call.end();
    }

    // get metadata of the object stored in the S3 object storage
    const params = { Bucket: bucket, Key: key };
    let headObject: any = await getHeadObject(params, this.ossClient, this.logger);
    if (headObject.status) {
      await call.write({
        response: {
          payload: null,
          status: {
            id: key,
            code: headObject.status.code,
            message: headObject.status.message
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      });
      return await call.end();
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
    } catch (err) {
      this.logger.info('No object tagging found for key:', { Key: key });
      await call.write({
        response: {
          payload: null,
          status: {
            id: key,
            code: err.code,
            message: err.message
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      });
      return await call.end();
    }
    // capture meta data from response message
    let metaObj;
    let data = {};
    let meta_subject = { id: '' };
    if (headObject && headObject.Metadata) {
      if (headObject.Metadata.meta) {
        metaObj = JSON.parse(headObject.Metadata.meta);
        // restore ACL from redis into metaObj
        const acl = await this.aclRedisClient.get(`${bucket}:${key}`);
        if (acl) {
          metaObj.acl = JSON.parse(acl);
        }
      }
      if (headObject.Metadata.data) {
        data = JSON.parse(headObject.Metadata.data);
      }
      if (headObject.Metadata.subject) {
        meta_subject = JSON.parse(headObject.Metadata.subject);
      }
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
      let tags: Attribute[] = [];
      let tagObj: Attribute;
      if (objectTagging) {
        // transform received object to respect our own defined structure
        let receivedTags = objectTagging.TagSet;

        for (let i = 0; i < receivedTags.length; i++) {
          tagObj = {
            id: receivedTags[i].Key,
            value: receivedTags[i].Value
          };
          tags.push(tagObj);
        }
      }

      const optionsObj: Options = { encoding, content_type, content_language, content_disposition, length, version, md5, tags };
      // Make ACS request with the meta object read from storage
      // When uploading files from the minio console the objects
      // have no meta stored so first check if meta is defined
      // before making the ACS request

      if (metaObj && metaObj.owner && metaObj.owner.length > 0) {
        let metaOwnerVal;
        const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
        for (let idVal of metaObj.owner) {
          if (idVal.id === ownerInstanceURN) {
            metaOwnerVal = idVal.value;
          }
        }
        // restore scope for acs check from metaObj owner
        subject.scope = metaOwnerVal;
      } else {
        this.logger.debug('Object metadata not found');
      }
      // resource identifier is key here
      let resource = { id: key, bucket, meta: metaObj, data, subject: { id: meta_subject.id } };
      let acsResponse: DecisionResponse; // isAllowed check for Read operation
      try {
        // target entity for ACS is bucket name here
        acsResponse = await checkAccessRequest(subject, resource, AuthZAction.READ,
          bucket, this);
      } catch (err) {
        this.logger.error('Error occurred requesting access-control-srv:', err);
        await call.write({
          response: {
            payload: null,
            status: {
              id: key,
              code: acsResponse.operation_status.code,
              message: acsResponse.operation_status.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        });
        return await call.end();
      }
      if (acsResponse.decision != Decision.PERMIT) {
        await call.write({
          response: {
            payload: null,
            status: {
              id: key,
              code: acsResponse.operation_status.code,
              message: acsResponse.operation_status.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        });
        return await call.end();
      }

      this.logger.info(`Received a request to get object ${key} on bucket ${bucket}`);

      // retrieve object from Amazon S3
      // and create stream from it
      const downloadable = this.ossClient.getObject({ Bucket: bucket, Key: key }).createReadStream();

      const transformBufferToGrpcObj = () => {
        return new Transform({
          objectMode: true,
          transform: (data, _, done) => {
            done(null, {
              response: {
                payload: { bucket, key, object: data, url: `//${bucket}/${key}`, options: optionsObj, meta: metaObj }
              },
            });
          }
        });
      };

      downloadable.on('end', async () => {
        await call.write({
          response: {
            payload: null,
            status: {
              id: key,
              code: 200,
              message: 'success'
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        });
        this.logger.debug('S3 read stream ended');
      });

      downloadable.on('error', async (err) => {
        this.logger.error('Error reading Object from Server', { error: err.message });
        const code = (err as any).code || 500;
        await call.write({
          response: {
            payload: null,
            status: {
              id: key,
              code,
              message: err.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        });
        return await call.end();
      });
      // Pipe through passthrough transformation stream
      try {
        downloadable.pipe(transformBufferToGrpcObj()).pipe(call.request);
      } catch (err) {
        this.logger.error('Error piping streamable response', { err: err.messsage });
        const code = (err as any).code || 500;
        await call.write({
          response: {
            payload: null,
            status: {
              id: key,
              code,
              message: err.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        });
        return await call.end();
      }
      // emit objectDownloadRequested event
      // collect all metadata
      let allMetadata = {
        optionsObj,
        metaObj,
        data,
        meta_subject
      };

      if (this.topics && this.topics['ostorage']) {
        // update downloader subject scope from findByToken with default_scope
        const dbSubject = await this.idsService.findByToken({ token: subject.token });
        subject.scope = dbSubject?.payload?.default_scope;
        const objectDownloadRequestPayload = {
          key,
          bucket,
          metadata: marshallProtobufAny(allMetadata),
          subject
        };
        this.topics['ostorage'].emit('objectDownloadRequested', objectDownloadRequestPayload);
      }

      return;
    }
  }

  /**
   * creates meta object containing owner information
   * @param reaources resource
   * @param orgKey orgKey
   */
  private createMetadata(resource: any, subject: Subject): any {
    let targetScope;
    if (!_.isEmpty(subject)) {
      targetScope = subject.scope;
    }
    let ownerAttributes = [];
    const urns = this.cfg.get('authorization:urns');
    if (targetScope) {
      ownerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: targetScope
        });
    }

    if (_.isEmpty(resource.meta)) {
      resource.meta = {};
    }
    if (_.isEmpty(resource.meta.owner)) {
      resource.meta.owner = ownerAttributes;
    }
    return resource;
  }

  async put(call: any, callback: any): Promise<PutResponse> {
    let key, bucket, meta, options, subject;
    let streamRequest = await call.getServerRequestStream();
    const readable = new Readable({ read() { } });

    streamRequest.on('data', (data) => {
      // add stream of data into a readable stream
      if (data.object) {
        readable.push(data.object);
      }
    });

    streamRequest.on('end', () => {
      // end of readable stream
      readable.push(null);
    });


    try {
      // pause till first chunk is received to make ACS request
      await new Promise((resolve: any, reject) => {
        if (!bucket || !key) {
          streamRequest.on('data', (data) => {
            bucket = data.bucket;
            key = data.key;
            options = data.options;
            subject = data.subject;
            meta = data.meta;
            resolve();
          });
        }
      });
      // validate object name and bucket
      if (!this.IsValidObjectName(key)) {
        return {
          response: {
            payload: null,
            status: {
              id: key,
              code: 400,
              message: `Invalid Object name ${key}`
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      }
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

      let resource = { key, bucket, meta, options };
      resource = this.createMetadata(resource, subject);
      const metaWithOwner = resource.meta;
      // created meta if it was not provided in request
      let acsResponse: DecisionResponse;
      try {
        // target entity for ACS is bucket name here
        acsResponse = await checkAccessRequest(subject, resource, AuthZAction.CREATE,
          bucket, this) as DecisionResponse;
      } catch (err) {
        this.logger.error('Error occurred requesting access-control-srv:', err);
        return {
          response: {
            payload: null,
            status: {
              id: key,
              code: err.code || 500,
              message: err.message
            }
          },
          operation_status: OPERATION_STATUS_SUCCESS
        };
      }
      if (acsResponse.decision != Decision.PERMIT) {
        return {
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
      }
      let subjectID = '';
      if (subject && subject.token) {
        const dbSubject = await this.idsService.findByToken({ token: subject.token });
        subjectID = dbSubject?.payload?.id;
      }
      if (subject && subject.id) {
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
    } catch (e) {
      this.logger.error('Error occurred while storing object.', e);
      return {
        response: {
          payload: null,
          status: {
            id: key,
            code: e.code,
            message: e.message
          }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
  }

  private async storeObject(key: string, bucket: string, readable: Readable, meta: any,
    options: Options, subjectID: string): Promise<PutResponse> {
    this.logger.info('Received a request to store Object:', { Key: key, Bucket: bucket });
    try {
      let data = {};
      if (options && options.data) {
        data = unmarshallProtobufAny(options.data);
      }
      let subject = {};
      if (subjectID) {
        subject = { id: subjectID };
      }

      let metaDataCopy = {
        meta,
        data,
        subject,
        key,
      };
      // Only Key Value pairs where the Values must be strings can be stored
      // inside the object metadata in S3, reason why we stringify the value fields.
      // When sending over Kafka we send metadata as google.protobuf.Any,
      // so we create a copy of the metaData object in unstringified state
      if (meta && meta.acl && !_.isEmpty(meta.acl)) {
        // store meta acl to redis
        await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(meta.acl));
        delete meta.acl;
      }

      let metaData = {
        meta: JSON.stringify(meta),
        data: JSON.stringify(data),
        subject: JSON.stringify(subject),
        key,
      };

      // get object length
      let length: number;
      length = readable.readableLength;

      // convert array of tags to query parameters
      // required by AWS.S3
      let TaggingQueryParams = '';
      let tagId: string, tagVal: string;
      if (options && options.tags) {
        let tags = options.tags;
        for (const [i, v] of tags.entries()) {
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
        options = {};
      }
      const result = await new Promise((resolve, reject) => {
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
        }, (err, data) => {
          if (err) {
            this.logger.error('Error occurred while storing object',
              {
                Key: key, Bucket: bucket, error: err, errStack: err.stack
              });
            return {
              response: {
                payload: null,
                status: {
                  id: key,
                  code: (err as any).code || 500,
                  message: err.message
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
        const url = `//${bucket}/${key}`;
        const tags = options && options.tags;
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
    } catch (err) {
      this.logger.error('Error storing object', err);
      return {
        response: {
          payload: null,
          status: { id: key, code: err.code, message: err.message }
        },
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
  }

  async move(call: Call<MoveRequestList>, context?: any): Promise<MoveResponseList> {
    let { items, subject } = call.request;
    let moveResponse: MoveResponseList = {
      response: [],
      operation_status: { code: 0, message: '' }
    };
    if (_.isEmpty(items)) {
      moveResponse.operation_status = { code: 400, message: 'Items missing in request' };
      return moveResponse;
    }

    for (let item of items) {
      let sourceBucketName, sourceKeyName;
      if (item.sourceObject) {
        (item as any).copySource = item.sourceObject;
        const copySource = item.sourceObject;
        let copySourceStr = copySource;
        if (copySource.startsWith('/')) {
          copySourceStr = copySource.slice(1, copySource.length);
        }
        sourceBucketName = copySourceStr.substring(0, copySourceStr.indexOf('/'));
        sourceKeyName = copySourceStr.substr(copySourceStr.indexOf('/'), copySourceStr.length);
      }
      // No need for ACS check as both Read and Create access check are made in Copy operation
      const copyResponse = await this.copy({ request: { items: [item], subject } }, context);
      // if copyResponse is success for each of the object then delete the sourceObject
      if (copyResponse?.operation_status?.code === 200) {
        for (let response of copyResponse.response) {
          if (response && response?.status?.code === 200) {
            // delete sourceObject Object
            const payload = response.payload;
            const deleteResponse = await this.delete({
              request: {
                bucket: sourceBucketName, key: sourceKeyName, subject
              }
            } as any);

            let deleteResponseCode, deleteResponseMessage;
            if (deleteResponse && deleteResponse.status && deleteResponse.status[0]) {
              deleteResponseCode = deleteResponse.status[0].code;
              deleteResponseMessage = deleteResponse.status[0].message;
            }

            if (deleteResponseCode === 200) {
              if (response.payload.copySource) {
                (response.payload as any).sourceObject = response.payload.copySource;
                delete response.payload.copySource;
              }
              moveResponse.response.push({
                payload: (response.payload as any),
                status: deleteResponse.status[0]
              });
            } else {
              // fail status
              moveResponse.response.push({
                status: {
                  id: payload.key,
                  code: deleteResponseCode,
                  message: deleteResponseMessage
                }
              });
            }
          } else {
            // fail status
            moveResponse.response.push({
              status: response.status
            });
          }
        }
      } else {
        moveResponse.operation_status = copyResponse.operation_status;
      }
    }
    moveResponse.operation_status = { code: 200, message: 'success' };
    return moveResponse;
  }

  async copy(call: any, callback: any): Promise<CopyResponseList> {
    const request = await call.request;
    let bucket: string;
    let copySource: string;
    let key: string;
    let meta: Meta;
    let options: Options;
    let grpcResponse: CopyResponseList = { response: [], operation_status: { code: 0, message: '' } };
    let copyObjectResult;
    let subject = call.request.subject;
    let destinationSubjectScope; // scope for destination bucket
    if (subject && subject.scope) {
      destinationSubjectScope = subject.scope;
    }
    if (request && request.items) {
      const itemsList = request.items;
      for (const item of itemsList) {
        bucket = item.bucket;
        copySource = item.copySource;
        key = item.key;
        meta = item.meta;
        if (!meta) {
          (meta as any) = {};
        }
        options = item.options;

        // Regex to extract bucket name and key from copySource
        // ex: copySource= /bucketName/sample-directory/objectName.txt
        if (!copySource) {
          grpcResponse.response.push({
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
        const sourceKeyName = copySourceStr.substr(copySourceStr.indexOf('/'), copySourceStr.length);

        // Start - Compose the copyObject params
        let params: CopyObjectParams = {
          Bucket: bucket,
          CopySource: copySource,
          Key: key
        };

        const headObjectParams = { Bucket: sourceBucketName, Key: sourceKeyName };
        let headObject: any = await getHeadObject(headObjectParams, this.ossClient, this.logger);
        if (headObject && headObject.status) {
          grpcResponse.response.push({
            status: {
              id: sourceKeyName,
              code: headObject.status.code,
              message: headObject.status.message
            }
          });
          continue;
        }
        let metaObj;
        let data = {};
        let meta_subject = { id: '' };
        if (headObject && headObject.Metadata) {
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
              metaObj.acl = JSON.parse(acl);
            }
          }
          if (headObject.Metadata.data) {
            data = JSON.parse(headObject.Metadata.data);
          }
          if (headObject.Metadata.subject) {
            meta_subject = JSON.parse(headObject.Metadata.subject);
          }
        }
        if (!subject) {
          subject = {};
        }
        if (metaObj && metaObj.owner && metaObj.owner.length > 0) {
          let metaOwnerVal;
          const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
          for (let idVal of metaObj.owner) {
            if (idVal.id === ownerInstanceURN) {
              metaOwnerVal = idVal.value;
            }
          }
          // restore scope for acs check from metaObj owner
          subject.scope = metaOwnerVal;
        }

        // ACS read request check for source Key READ and CREATE action request check for destination Bucket
        let resource = { id: key, key, sourceBucketName, meta: metaObj, data, subject: { id: meta_subject.id } };
        let acsResponse: DecisionResponse; // isAllowed check for Read operation
        try {
          // target entity for ACS is source bucket here
          acsResponse = await checkAccessRequest(subject, resource, AuthZAction.READ,
            sourceBucketName, this);
        } catch (err) {
          this.logger.error('Error occurred requesting access-control-srv:', err);
          grpcResponse.response.push({
            status: {
              id: sourceKeyName,
              code: err.code || 500,
              message: err.message
            }
          });
          continue;
        }
        if (acsResponse.decision != Decision.PERMIT) {
          grpcResponse.response.push({
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
        let sourceACL = metaObj.acl;
        metaObj.acl = meta?.acl ? meta.acl : [];
        resource.meta = metaObj;
        let writeAccessResponse = await checkAccessRequest(subject, resource,
          AuthZAction.CREATE, bucket, this);
        if (writeAccessResponse.decision != Decision.PERMIT) {
          grpcResponse.response.push({
            status: {
              id: key,
              code: writeAccessResponse.operation_status.code || 500,
              message: writeAccessResponse.operation_status.message
            }
          });
          continue;
        }
        // need to iterate and check if there is at least one key set
        // since the gRPC adds default values for missing fields
        let optionsExist = false;
        let optionKeys = [];
        if (options) {
          optionKeys = Object.keys(options);
        }
        for (let optKey of optionKeys) {
          if (!_.isEmpty(options[optKey])) {
            optionsExist = true;
            break;
          }
        }

        // CASE 1: User provides at least one option => replace all obj meta including tagging

        if (optionsExist) {
          params.MetadataDirective = 'REPLACE';
          params.TaggingDirective = 'REPLACE';

          // 1. Add user defined Metadata if its not provided
          if (!meta) {
            meta = {} as any;
          }
          if (_.isEmpty(meta.owner)) {
            const urns = this.cfg.get('authorization:urns');
            meta.owner = [{
              id: urns.ownerIndicatoryEntity,
              value: urns.organization
            },
            {
              id: urns.ownerInstance,
              value: destinationSubjectScope
            }];
          }
          if (meta && meta.acl && !_.isEmpty(meta.acl)) {
            // store meta acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(meta.acl));
            delete meta.acl;
          } else if (sourceACL && !_.isEmpty(sourceACL)) {
            // store source acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(sourceACL));
          }
          params.Metadata = {
            meta: JSON.stringify(meta), // TODO remove it and store to redis ?
            key,
            subject: JSON.stringify({ id: subject.id })
          };
          // override data if it is provided
          if (options.data) {
            // params.Metadata.data = JSON.stringify(options.data);
            params.Metadata.data = JSON.stringify(unmarshallProtobufAny(options.data));
          } else {
            params.Metadata.data = JSON.stringify(data);
          }

          // 2. Add object metadata if provided
          // ContentEncoding
          if (!_.isEmpty(options.encoding)) {
            params.ContentEncoding = options.encoding;
          }
          // ContentType
          if (!_.isEmpty(options.content_type)) {
            params.ContentType = options.content_type;
          }
          // ContentLanguage
          if (!_.isEmpty(options.content_language)) {
            params.ContentLanguage = options.content_language;
          }
          // ContentDisposition
          if (!_.isEmpty(options.content_disposition)) {
            params.ContentDisposition = options.content_disposition;
          }

          // 3. Add Tagging if provided [ first convert array of tags to query parameters (it is required by S3) ]
          let TaggingQueryParams = '';
          let tagId: string, tagVal: string;
          if (!_.isEmpty(options.tags)) {
            const tagsList = options.tags;
            for (const [i, v] of tagsList.entries()) {
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
          } catch (err) {
            grpcResponse.response.push({
              status: {
                id: key,
                code: err.code || 500,
                message: err.message
              }
            });
          }
        } else {

          // CASE 2: No options provided => copy the object as it is and update user defined metadata (owner)

          // 1. Add user defined Metadata if its not provided
          params.MetadataDirective = 'REPLACE';
          if (!meta) {
            meta = {} as any;
          }
          if (_.isEmpty(meta.owner)) {
            const urns = this.cfg.get('authorization:urns');
            meta.owner = [{
              id: urns.ownerIndicatoryEntity,
              value: urns.organization
            },
            {
              id: urns.ownerInstance,
              value: destinationSubjectScope
            }];
          }
          if (meta && meta.acl && !_.isEmpty(meta.acl)) {
            // store meta acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(meta.acl));
            delete meta.acl;
          } else if (sourceACL && !_.isEmpty(sourceACL)) {
            // store source acl to redis
            await this.aclRedisClient.set(`${bucket}:${key}`, JSON.stringify(sourceACL));
          }
          params.Metadata = {
            data: JSON.stringify(data),
            meta: JSON.stringify(meta), // TODO remove it and store to redis ?
            key,
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
          } catch (err) {
            grpcResponse.response.push({
              status: {
                id: key,
                code: err.code || 500,
                message: err.message
              }
            });
          }
        }

        if (copyObjectResult) {
          let copiedObject: CopyResponse = {
            bucket,
            copySource,
            key,
            meta,
            options
          };
          grpcResponse.response.push({ payload: copiedObject, status: { id: key, code: 200, message: 'success' } });
        } else {
          this.logger.error('Copy object failed for:', { DestinationBucket: bucket, CopySource: copySource, Key: key, Meta: meta, Options: options });
        }
      }
    }
    grpcResponse.operation_status = { code: 200, message: 'success' };
    return grpcResponse;
  }

  // Regular expression that checks if the filename string contains
  // only characters described as safe to use in the Amazon S3
  // Object Key Naming Guidelines
  private IsValidObjectName(key: string): boolean {
    const allowedCharacters = new RegExp('^[a-zA-Z0-9-!_.*\'()@/]+$');
    return (allowedCharacters.test(key));
  }

  async delete(call: Call<DeleteRequest>, context?: any): Promise<DeleteResponse> {
    const { bucket, key } = call.request;
    let subject = call.request.subject;
    if (!_.includes(this.buckets, bucket)) {
      return {
        status: [{ id: key, code: 400, message: `Invalid bucket name ${bucket}` }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }

    this.logger.info(`Received a request to delete object ${key} on bucket ${bucket}`);
    let resources = { Bucket: bucket, Key: key };
    let headObject: any = await getHeadObject(resources, this.ossClient, this.logger);
    if (headObject && headObject.status) {
      return {
        status: [{ id: key, code: headObject.status.code, message: headObject.status.message }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
    // capture meta data from response message
    let metaObj;
    let data = {};
    let meta_subject = { id: '' };
    if (headObject && headObject.Metadata) {
      if (headObject.Metadata.meta) {
        metaObj = JSON.parse(headObject.Metadata.meta);
        // restore ACL from redis into metaObj
        const acl = await this.aclRedisClient.get(`${bucket}:${key}`);
        if (acl) {
          metaObj.acl = JSON.parse(acl);
        }
      }
      if (headObject.Metadata.data) {
        data = JSON.parse(headObject.Metadata.data);
      }
      if (headObject.Metadata.subject) {
        meta_subject = JSON.parse(headObject.Metadata.subject);
      }
    }
    Object.assign(resources, { meta: metaObj, data, subject: { id: meta_subject.id } });
    let acsResponse: DecisionResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, AuthZAction.DELETE,
        bucket, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        status: [{ id: key, code: err.code, message: err.message }],
        operation_status: OPERATION_STATUS_SUCCESS
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
      this.logger.error('Error caught enabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }
}
