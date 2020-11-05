import * as _ from 'lodash';
import * as aws from 'aws-sdk';
import * as MemoryStream from 'memorystream';
import { PassThrough, Readable } from 'stream';
import { errors } from '@restorecommerce/chassis-srv';
import { toObject } from '@restorecommerce/resource-base-interface';
import { RedisClient } from 'redis';
import { getSubject, checkAccessRequest, AccessResponse } from './utils';
import { PermissionDenied, Decision, AuthZAction, ACSAuthZ, Resource, Subject, updateConfig } from '@restorecommerce/acs-client';
import {
  Attribute, Options, FilterType, RequestType,
  GetRequest, ListRequest, DeleteRequest, Call,
  PutRequest, PutResponse, CopyRequest, CopyResponse,
  CopyRequestList, CopyResponseList, CopyObjectParams,
  Owner, Meta
} from './interfaces';

const META_OWNER = 'meta.owner';
const EQ = 'eq';

export class Service {
  ossClient: aws.S3; // object storage frameworks are S3-compatible
  buckets: string[];
  bucketsLifecycleConfigs?: any;
  redisClient: RedisClient;
  authZ: ACSAuthZ;
  cfg: any;
  authZCheck: boolean;

  constructor(cfg: any, private logger: any, authZ: ACSAuthZ, redisClient: RedisClient) {
    this.ossClient = new aws.S3(cfg.get('s3:client'));
    this.buckets = cfg.get('s3:buckets') || [];
    this.bucketsLifecycleConfigs = cfg.get('s3.bucketsLifecycleConfigs');
    this.authZ = authZ;
    this.redisClient = redisClient;
    this.cfg = cfg;
    this.authZCheck = cfg.get('authorization:enabled');
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

  private filterObjects(hasFilter, requestFilter, object, objectToReturn) {
    // if filter is provided return data based on filter
    if (hasFilter && requestFilter.field == META_OWNER && requestFilter.operation == EQ && requestFilter.value) {
      const MetaOwnerVal = object.meta.owner[1].value;
      // check only for the files matching the requested Owner Organizations
      if (requestFilter.value == MetaOwnerVal) {
        objectToReturn.push(object);
      }
    } else { // else return all data
      objectToReturn.push(object);
    }
  }

  async list(call: Call<ListRequest>, context?: any): Promise<any> {
    let { bucket, filter } = call.request;

    let subject = call.request.subject;
    let api_key = call.request.api_key;
    subject = await getSubject(subject, api_key, this.redisClient);
    let resource: any = { bucket, filter };
    let acsResponse: AccessResponse;
    try {
      // target entity for ACS is bucket name here
      Object.assign(resource, { subject });
      acsResponse = await checkAccessRequest(subject, resource, AuthZAction.READ,
        bucket, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
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
    // if request contains a filter return data based on it
    let hasFilter = false;
    let requestFilter;
    if (filter) {
      hasFilter = true;
      // convert filter from struct back to object
      requestFilter = toObject(filter);
    }
    let buckets = [];
    if (bucket) {
      buckets.push(bucket);
    } else {
      buckets = this.buckets;
    }
    let objectToReturn = [];

    for (const value of buckets) {
      if (value != null) {
        let bucketName = { Bucket: value };
        let objList: any;
        try {
          objList = await new Promise((resolve, reject) => {
            this.ossClient.listObjectsV2(bucketName, (err, data) => {
              if (err) {
                this.logger.error('Error occurred while listing objects',
                  {
                    bucket: bucketName, error: err, errorStack: err.stack
                  });
                reject(err);
              } else {
                return resolve(data.Contents);
              }
            });
          });
        } catch (err) {
          throw err;
        }

        if (objList != null) {
          for (let eachObj of objList) {
            const headObjectParams = { Bucket: value, Key: eachObj.Key };
            let meta: any;
            try {
              meta = await new Promise((resolve, reject) => {
                this.ossClient.headObject(headObjectParams, (err: any, data) => {
                  if (err) {
                    this.logger.error('Error occurred while reading meta data for objects',
                      {
                        bucket: bucketName, error: err, errorStack: err.stack
                      });
                    // map the s3 error codes to standard chassis-srv errors
                    if (err.code === 'NotFound') {
                      err = new errors.NotFound('Specified key does not exist');
                      err.code = 404;
                    }
                    if (!err.message) {
                      err.message = err.name;
                    }
                    reject(err);
                  } else {
                    resolve(data.Metadata);
                  }
                });
              });
            } catch (err) {
              throw err;
            }
            const url = `//${value}/${meta.key}`;
            const objectName = meta.key;
            let objectMeta;
            if (meta && meta.meta) {
              objectMeta = JSON.parse(meta.meta);
            }
            let object = { object_name: objectName, url, meta: objectMeta };
            // authorization filter check
            if (this.cfg.get('authorization:enabled')) {
              // if target objects owner instance `ownerInst` is contained in the
              // list of applicable `ownerValues` returned from ACS ie. ownerValues.includes(ownerInst)
              // then its considred a match for further filtering based on filter field if it exists
              let match = false;
              let ownerInst;
              if (objectMeta.owner) {
                for (let idVal of objectMeta.owner) {
                  if (idVal.id === ownerIndictaorEntURN && idVal.value === ownerIndicatorEntity) {
                    match = true;
                  }
                  if (idVal.id === ownerInstanceURN) {
                    ownerInst = idVal.value;
                  }
                }
                if (match && ownerInst && ownerValues.includes(ownerInst)) {
                  this.filterObjects(hasFilter, requestFilter, object, objectToReturn);
                }
                // no scoping defined in the Rule
                if (!ownerValues) {
                  objectToReturn.push(object);
                }
              }
            } else {
              this.filterObjects(hasFilter, requestFilter, object, objectToReturn);
            }
          }
        }
      }
    }
    return objectToReturn;
  }

  async get(call: any, context?: any): Promise<any> {

    // get gRPC call request
    const { bucket, key, download } = call.request;
    let subject = call.request.subject;
    let api_key = call.request.api_key;
    // GET meta from stored object and query for accessReq with this meta
    if (!_.includes(this.buckets, bucket)) {
      return await call.end(new errors.InvalidArgument(`Invalid bucket name ${bucket}`));
    }
    if (!key) {
      return await call.end(new errors.InvalidArgument(`Invalid key name ${key}`));
    }

    // get metadata of the object stored in the S3 object storage
    const params = { Bucket: bucket, Key: key };
    let headObject: any;
    headObject = await new Promise((resolve, reject) => {
      this.ossClient.headObject(params, async (err: any, data) => {
        if (err) {
          // map the s3 error codes to standard chassis-srv errors
          if (err.code === 'NotFound') {
            err = new errors.NotFound('Specified key does not exist');
            err.code = 404;
          }
          this.logger.error('Error occurred while retrieving metadata for key:', { Key: key, error: err });
          return await call.end(err);
        }
        resolve(data);
      });
    });

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
            this.logger.error('Error occurred while retrieving metadata for key:',
              {
                Key: key, error: err, errorStack: err.stack
              });
            reject(err);
            return await call.end(err);
          } else {
            resolve(data);
          }
        });
      });
    } catch (err) {
      this.logger.info('No object tagging found for key:', { Key: key });
    }
    // capture meta data from response message
    let metaObj;
    let data = {};
    let meta_subject = { id: '' };
    if (headObject && headObject.Metadata) {
      if (headObject.Metadata.meta) {
        metaObj = JSON.parse(headObject.Metadata.meta);
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
        // capture meta data from response message
        let metaObj;
        if (headObject && headObject.Metadata && headObject.Metadata.meta) {
          metaObj = JSON.parse(headObject.Metadata.meta);
        }
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
      if (!subject) {
        subject = {};
      }
      if (metaObj.owner && metaObj.owner[1]) {
        subject.scope = metaObj.owner[1].value;
      }
      subject = await getSubject(subject, api_key, this.redisClient);
      let resource = { key, bucket, meta: metaObj, data, subject: { id: meta_subject.id } };
      let acsResponse: AccessResponse;
      try {
        // target entity for ACS is bucket name here
        acsResponse = await checkAccessRequest(subject, resource, AuthZAction.READ,
          bucket, this);
      } catch (err) {
        this.logger.error('Error occurred requesting access-control-srv:', err);
        return await call.end(err);
      }
      if (acsResponse.decision != Decision.PERMIT) {
        const err = new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
        return await call.end(err);
      }

      this.logger.info(`Received a request to get object ${key} on bucket ${bucket}`);

      // retrieve object from Amazon S3
      // and create stream from it
      const stream = new MemoryStream(null);
      const downloadable = this.ossClient.getObject({ Bucket: bucket, Key: key }).createReadStream();
      stream.pipe(downloadable);

      // write data to gRPC call
      await new Promise<any>((resolve, reject) => {
        downloadable
          .on('httpData', async (chunk) => {
            await call.write({ bucket, key, object: chunk, url: `//${bucket}/${key}`, options: optionsObj, meta: metaObj });
          })
          .on('data', async (chunk) => {
            await call.write({ bucket, key, object: chunk, url: `//${bucket}/${key}`, options: optionsObj, meta: metaObj });
          })
          .on('httpDone', async () => {
            resolve();
          })
          .on('end', async (chunk) => {
            await call.end();
            resolve();
          })
          .on('finish', async (chunk) => {
            await call.end();
            resolve();
          })
          .on('httpError', async (err: any) => {
            if (err.code === 'NotFound') {
              err = new errors.NotFound('Specified key does not exist');
              err.code = 404;
            }
            // map the s3 error codes to standard chassis-srv errors
            this.logger.error('HTTP error occurred while getting object',
              {
                Key: key, error: err, errorStack: err.stack
              });
            await call.end(err);
            return reject(err);
          })
          .on('error', async (err: any) => {
            // map the s3 error codes to standard chassis-srv errors
            if (err.code === 'NotFound') {
              err = new errors.NotFound('Specified key does not exist');
              err.code = 404;
            }
            this.logger.error('Error occurred while getting object',
              {
                Key: key, error: err, errorStack: err.stack
              });
            await call.end(err);
            return reject(err);
          });
      });
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

  private unmarshallProtobufAny(msg: any): any {
    if (msg && msg.value) {
      return JSON.parse(msg.value.toString());
    }
  }

  async put(call: any, callback: any): Promise<PutResponse> {
    let stream = true;
    let completeBuffer = [];
    let key, bucket, meta, object, options, subject, api_key;

    while (stream) {
      try {
        let streamRequest = await call.read();
        // Promisify callback to get response
        const streamResponse: any = await new Promise((resolve, reject) => {
          streamRequest((err, response) => {
            if (err) {
              reject(err);
            }
            resolve(response);
          });
        });
        bucket = streamResponse.bucket;
        key = streamResponse.key;
        meta = streamResponse.meta;
        object = streamResponse.object;
        options = streamResponse.options;
        subject = streamResponse.subject;
        api_key = streamResponse.api_key;
        // check object name
        if (!this.IsValidObjectName(key)) {
          stream = false;
          throw new errors.InvalidArgument(`Invalid Object name ${key}`);
        }
        if (!_.includes(this.buckets, bucket)) {
          stream = false;
          throw new errors.InvalidArgument(`Invalid bucket name ${bucket}`);
        }

        completeBuffer.push(object);
      } catch (e) {
        stream = false;
        if (e.message != 'stream end') {
          this.logger.error('Error occurred while storing object...', e);
          throw e;
        }
      }
    }
    if (!stream) {
      let response;
      if (options && options.data) {
        options.data = this.unmarshallProtobufAny(options.data);
      }
      try {
        subject = await getSubject(subject, api_key, this.redisClient);
        let resource = { key, bucket, meta, options };
        this.createMetadata(resource, subject);
        // created meta if it was not provided in request
        meta = resource.meta;
        let acsResponse: AccessResponse;
        try {
          // target entity for ACS is bucket name here
          acsResponse = await checkAccessRequest(subject, resource, AuthZAction.CREATE,
            bucket, this);
        } catch (err) {
          this.logger.error('Error occurred requesting access-control-srv:', err);
          throw err;
        }
        if (acsResponse.decision != Decision.PERMIT) {
          throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
        }
        let subjectID = '';
        if (subject && subject.id) {
          subjectID = subject.id;
        }
        response = await this.storeObject(
          key,
          bucket,
          Buffer.concat(completeBuffer), // object
          meta,
          options,
          subjectID
        );
        return response;
      } catch (e) {
        this.logger.error('Error occurred while storing object.', e);
        throw e; // if you throw without a catch block you get an error
      }
    }
  }

  async copy(call: any, callback: any): Promise<CopyResponseList> {
    const request = await call.request;
    let bucket: string;
    let copySource: string;
    let key: string;
    let meta: Meta;
    let options: Options;
    let grpcResponse: CopyResponseList = { response: [] };
    let copyObjectResult;

    let subject = call.request.subject;
    let api_key = call.request.api_key;
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
        options = item.options;

        // Regex to extract bucket name and key from copySource
        // ex: copySource= /bucketName/sample-directory/objectName.txt
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
        let headObject: any;
        try {
          headObject = await new Promise((resolve, reject) => {
            this.ossClient.headObject(headObjectParams, (err: any, data) => {
              if (err) {
                this.logger.error('Error occurred while retrieving metadata for object:',
                  {
                    Bucket: sourceBucketName, Key: sourceKeyName, error: err, errorStack: err.stack
                  });
                // map the s3 error codes to standard chassis-srv errors
                if (err.code === 'NotFound') {
                  err = new errors.NotFound('Specified key does not exist');
                  err.code = 404;
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
          throw err;
        }
        let metaObj;
        let data = {};
        let meta_subject = { id: '' };
        if (headObject && headObject.Metadata) {
          if (headObject.Metadata.meta) {
            metaObj = JSON.parse(headObject.Metadata.meta);
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
        if (metaObj && metaObj.owner && metaObj.owner[1]) {
          // modifying the scope to check for read operation
          subject.scope = metaObj.owner[1].value;
        }
        subject = await getSubject(subject, api_key, this.redisClient);

        // ACS read request check for source Key READ and CREATE action request check for destination Bucket
        let resource = { key, sourceBucketName, meta: metaObj, data, subject: { id: meta_subject.id } };
        let acsResponse: AccessResponse;
        try {
          // target entity for ACS is source bucket here
          acsResponse = await checkAccessRequest(subject, resource, AuthZAction.READ,
            sourceBucketName, this);
        } catch (err) {
          this.logger.error('Error occurred requesting access-control-srv:', err);
          throw err;
        }
        if (acsResponse.decision != Decision.PERMIT) {
          throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
        }

        // check write access to destination bucket
        subject.scope = destinationSubjectScope;
        // target entity for ACS is destination bucket here
        let writeAccessResponse = await checkAccessRequest(subject, resource,
          AuthZAction.CREATE, bucket, this);
        if (writeAccessResponse.decision != Decision.PERMIT) {
          throw new PermissionDenied(writeAccessResponse.response.status.message, writeAccessResponse.response.status.code);
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
          params.Metadata = {
            meta: JSON.stringify(meta),
            key,
            subject: JSON.stringify({ id: subject.id })
          };
          // override data if it is provided
          if (options.data) {
            // params.Metadata.data = JSON.stringify(options.data);
            params.Metadata.data = JSON.stringify(this.unmarshallProtobufAny(options.data));
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
            throw err;
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
          params.Metadata = {
            data: JSON.stringify(data),
            meta: JSON.stringify(meta),
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
            throw err;
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
          grpcResponse.response.push(copiedObject);
        } else {
          this.logger.error('Copy object failed for:', { DestinationBucket: bucket, CopySource: copySource, Key: key, Meta: meta, Options: options });
        }
      }
    }
    return grpcResponse;
  }

  // Regular expression that checks if the filename string contains
  // only characters described as safe to use in the Amazon S3
  // Object Key Naming Guidelines
  private IsValidObjectName(key: string): boolean {
    const allowedCharacters = new RegExp('^[a-zA-Z0-9-!_.*\'()/]+$');
    return (allowedCharacters.test(key));
  }

  private async storeObject(key: string, bucket: string, object: any, meta: any,
    options: Options, subjectID: string): Promise<PutResponse> {
    this.logger.info('Received a request to store Object:', { Key: key, Bucket: bucket });
    try {
      let data = {};
      if (options && options.data) {
        data = options.data;
      }
      let subject = {};
      if (subjectID) {
        subject = { id: subjectID };
      }
      // only string data type can be stored in object metadata
      let metaData = {
        meta: JSON.stringify(meta),
        data: JSON.stringify(data),
        subject: JSON.stringify(subject),
        key,
      };
      // add stream of data into a readable stream
      const readable = new Readable();
      readable.push(object);
      readable.push(null);
      // create writable stream in which we pipe the readable stream
      const passStream = new PassThrough();
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
      const uploadable = this.ossClient.upload({
        Key: key,
        Bucket: bucket,
        Body: passStream,
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
          throw err;
        } else {
          return data;
        }
      });
      readable.pipe(passStream);

      const output = await new Promise<any>((resolve, reject) => {
        uploadable.send((err, data) => {
          if (err) {
            this.logger.error('Error:', err.code, err.message);
            reject(err);
          } else {
            resolve(data);
          }
        });
        uploadable.on('httpUploadProgress', (chunk) => {
          if (chunk.loaded == chunk.total) {
            this.logger.info(`Successfully persisted object ${key}
                        in bucket ${bucket}`);
            resolve(true);
          }
        });
      });
      if (output) {
        const url = `//${bucket}/${key}`;
        const tags = options && options.tags;
        return { key, bucket, url, meta, tags, length };
      } else {
        this.logger.error('No output returned when trying to store object',
          {
            Key: key, Bucket: bucket
          });
      }
    } catch (err) {
      this.logger.error('Error occurred while storing object',
        {
          Key: key, Bucket: bucket, error: err, errStack: err.stack
        });
      return (err);
    }
  }

  async delete(call: Call<DeleteRequest>, context?: any): Promise<void> {
    const { bucket, key } = call.request;
    let subject = await getSubject(call.request.subject, call.request.api_key, this.redisClient);
    if (!_.includes(this.buckets, bucket)) {
      throw new errors.InvalidArgument(`Invalid bucket name ${bucket}`);
    }

    this.logger.info(`Received a request to delete object ${key} on bucket ${bucket}`);
    let headObject: any;
    let resources = { Bucket: bucket, Key: key };
    try {
      headObject = await new Promise((resolve, reject) => {
        this.ossClient.headObject(resources, async (err: any, data) => {
          if (err) {
            this.logger.error('Error occurred while retrieving metadata for key:', { Key: key, error: err });
            // map the s3 error codes to standard chassis-srv errors
            if (err.code === 'NotFound') {
              err = new errors.NotFound('Specified key does not exist');
              err.code = 404;
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
      throw err;
    }
    // capture meta data from response message
    let metaObj;
    let data = {};
    let meta_subject = { id: '' };
    if (headObject && headObject.Metadata) {
      if (headObject.Metadata.meta) {
        metaObj = JSON.parse(headObject.Metadata.meta);
      }
      if (headObject.Metadata.data) {
        data = JSON.parse(headObject.Metadata.data);
      }
      if (headObject.Metadata.subject) {
        meta_subject = JSON.parse(headObject.Metadata.subject);
      }
    }
    Object.assign(resources, { meta: metaObj, data, subject: { id: meta_subject.id } });
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, AuthZAction.DELETE,
        bucket, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    const result = await this.ossClient.deleteObject({
      Bucket: bucket,
      Key: key
    }).promise();

    if (result.$response.error) {
      this.logger.error(`Error while deleting object ${key} from bucket ${bucket}`, {
        error: result.$response.error
      });
      throw result.$response.error;
    }
    this.logger.info(`Successfully deleted object ${key} from bucket ${bucket}`);
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
