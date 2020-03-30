# ostorage-srv

[![Build Status][build]](https://travis-ci.org/restorecommerce/ostorage-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/ostorage-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/ostorage-srv?branch=master)

[build]: http://img.shields.io/travis/restorecommerce/ostorage-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/ostorage-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/ostorage-srv/master.svg?style=flat-square

A RestoreCommerce microservice for abstracting object storage through [gRPC](https://grpc.io/docs/).
It uses an [AWS SDK](https://www.npmjs.com/package/aws-sdk) client for connecting to an object storage framework.
The service exposes `put`, `get`, `list` and `delete` operations via gRPC interface.
This service can be used with Object Storage Server compatible with S3 API and this can be configured in [config.json](./cfg/config.json).

## Configuration

The following Object Storage Server configuration properties under [`s3`](./cfg/config.json#L2) configuration are available:

- `client.accessKeyId`: access key ID for Object Storage Server
- `client.secretAccessKey`: secret access key for Object Storage Server
- `client.endpoint`: Object Storage Server endpoint
- `client.s3ForcePathStyle`: Whether to force path style URLs for S3 objects
- `buckets`: list of buckets to be created on server start up

## gRPC Interface

This microservice exposes the following gRPC endpoints:

### `Put`

Used to store the Object to the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.Object` protobuf message as input and response is `io.restorecommerce.ostorage.Response` message.

`io.restorecommerce.ostorage.Object`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object should be mapped to.|
| object | bytes | required | Blob.|
| key | string | required | Object Key.|
| meta | [io.restorecommerce.meta.Meta](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | optional | metadata attached to Object.|
| options | [io.restorecommerce.ostorage.Options](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/ostorage.proto) | optional | headers attached to Object.|

`io.restorecommerce.ostorage.Options`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| encoding | string | optional | ContentEncoding header - Specifies what content encodings have been applied to the object and thus what decoding mechanisms must be applied to obtain the media-type referenced by the Content-Type header field.|
| content_type | string | required | ContentType header - A standard MIME type describing the format of the contents.|
| content_language | string | required | ContentLanguage header - The language the content is in.|
| content_disposition | string | optional | ContentDisposition header - Specifies presentational information for the object.|
| length | int32 | optional | ContentLength header - Size of the body in bytes. This parameter is useful when the size of the body cannot be determined automatically.|
| version | string | optional | x-amz-version-id header - Version ID of the newly created object, in case the bucket has versioning turned on.|
| md5 | string | optional | ETag - Entity tag that identifies the newly created object's data.|

`io.restorecommerce.ostorage.Response`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| url | string | required | url of saved Object.|
| bucket | string | required | Bucket to which the object is mapped to.|
| key | string | optional | Object Key.|
| meta | [io.restorecommerce.meta.Meta](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | optional | metadata attached to Object.|
### `Get`

Used to retrieve the Object from the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.GetRequest` protobuf message as input and response is `io.restorecommerce.ostorage.Object` message.

`io.restorecommerce.ostorage.GetRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| key | string | optional | Object Key.|
| bucket | string | required | Bucket to which the object is mapped to.|
| flag | boolean | optional | If flag is set to `true` only metadata of object is fetched.|
| download | boolean | optional | If flag is set to `true` then Content-Disposition is set as `attachment` else is set as `inline`.|

### `List`

Used to list all the Objects in a Bucket from the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.ListRequest` protobuf message as input and response is `io.restorecommerce.ostorage.ObjectsData` message.

`io.restorecommerce.ostorage.ListRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | optional | If bucket name provied it will return its files otherwise it will return all files. |
| filter | google.protobuf.Struct | optional | Filter based on fieldName, operation, value. |

`io.restorecommerce.ostorage.ObjectsData`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| object_data | [ ] `io.restorecommerce.ostorage.ObjectData` | required | Objects data. |

`io.restorecommerce.ostorage.ObjectData`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| url | string | required | url for Object. |
| object_name | string | required | Object name. |
| meta | [io.restorecommerce.meta.Meta](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | optional | metadata attached to Object.|

### `Delete`

Used to delete the Object mapped to the Bucket from the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.Bucket` protobuf message as input and response is `google.protobuf.Empty` message.

`io.restorecommerce.ostorage.DeleteRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object is mapped to. |
| key | string | required | Object key. |

## Kafka Events

This microservice subscribes to the following events by topic:

| Topic Name | Event Name | Description |
| ----------- | ------------ | ------------- |
| `io.restorecommerce.command` | `restoreCommand` | for triggering for system restore |
|                              | `resetCommand` | for triggering system reset |
|                              | `healthCheckCommand` | to get system health check |
|                              | `versionCommand` | to get system version |

List of events emitted by this microservice for below topics:

| Topic Name | Event Name | Description |
| ----------- | ------------ | ------------- |
| `io.restorecommerce.command` | `restoreResponse` | system restore response |
|                              | `resetResponse` | system reset response |
|                              | `healthCheckResponse` | system health check response |
|                              | `versionResponse` | system version response |

**Note**: currently restore and reset is not implemented.

## Chassis Service

This service uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base module for [restorecommerce](https://github.com/restorecommerce) microservices, in order to provide the following functionalities:

- exposure of all previously mentioned gRPC endpoints
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- Kafka offset value storage at regular intervals to [Redis](https://redis.io/).

## Development

### Tests

See [tests](test/). To execute the tests a running instance of [MinIO](https://min.io/) is needed.
Refer to [System](https://github.com/restorecommerce/system) repository to start the backing-services before running the tests.

- To run tests

```sh
npm run test
```

**Note**: although any kind of gRPC client can be used to connect to these endpoints, the tests make use of the [grpc-client](https://github.com/restorecommerce/grpc-client),
a [restorecommerce](https://github.com/restorecommerce) module which allows an application to connect to multiple gRPC endpoints with custom middleware, loadbalancing and retry/timeout support.

## Running as Docker Container

This service depends on a set of _backing services_ that can be started using a
dedicated [docker compose definition](https://github.com/restorecommerce/system).

```sh
docker run \
 --name restorecommerce_ostorage_srv \
 --hostname ostorage-srv \
 --network=system_test \
 -e NODE_ENV=production \
 -p 50066:50066 \
 restorecommerce/ostorage-srv
```

## Running Locally

Install dependencies

```sh
npm install
```

Build service

```sh
# compile the code
npm run build
```

Start service

```sh
# run compiled service
npm start
```
