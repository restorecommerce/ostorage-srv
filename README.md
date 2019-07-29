# ostorage-srv

<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fostorage%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/ostorage-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/ostorage-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/ostorage-srv?branch=master)

[version]: http://img.shields.io/npm/v/ostorage-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/ostorage-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/ostorage-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/ostorage-srv/master.svg?style=flat-square

A RestoreCommerce microservice for abstracting object storage through [gRPC](https://grpc.io/docs/).
It uses an [AWS SDK](https://www.npmjs.com/package/aws-sdk) client for connecting to an object storage framework. 
The service exposes `put`, `get`, `list` and `delete` operations via gRPC interface.
This service can be used with Object Storage Server compatible with S3 API and this can be configured in [config.json](./cfg/config.json).


## gRPC Interface

This microservice exposes the following gRPC endpoints:

#### Put
Used to store the Object to the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.Object` protobuf message as input and response is `io.restorecommerce.ostorage.Result` message.

`io.restorecommerce.ostorage.Object`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object should be mapped to.|
| object | bytes | required | Blob.|
| meta | [io.restorecommerce.meta.Meta](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | optional | metadata attached to Object.|
| key | string | optional | Object Key.|

`io.restorecommerce.ostorage.Result`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| url | string | required | url of saved Object.|
| bucket | string | required | Bucket to which the object is mapped to.|
| key | string | optional | Object Key.|


#### Get
Used to retreive the Object from the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.GetRequest` protobuf message as input and response is `io.restorecommerce.ostorage.Object` message.

`io.restorecommerce.ostorage.GetRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| key | string | optional | Object Key.|
| bucket | string | required | Bucket to which the object is mapped to.|
| flag | boolean | optional | If flag is set to `true` only metadata of object is fetched.|

#### List
Used to list all the Objects in a Bucket from the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.Bucket` protobuf message as input and response is `io.restorecommerce.ostorage.ObjectsData` message.

`io.restorecommerce.ostorage.Bucket`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | optional | If bucket name provied it will return its files otherwise it will return all files. |


`io.restorecommerce.ostorage.ObjectsData`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| object_data | [ ] `io.restorecommerce.ostorage.ObjectData` | required | Objects data. |

`io.restorecommerce.ostorage.ObjectData`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| url | string | required | url for Object. |
| object_name | string | required | Object name. |
| meta | [ ] `google.protobuf.Any` | optional | meta information of object.|


#### Delete

Used to delete the Object mapped to the Bucket from the Storage Server.
Requests are performed using `io.restorecommerce.ostorage.Bucket` protobuf message as input and response is `google.protobuf.Empty` message.

`io.restorecommerce.ostorage.DeleteRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object is mapped to. |
| key | string | required | Object key. |


## Kafka Events

This microservice subscribes to the following Kafka events by topic:
- io.restorecommerce.command
  - restoreCommand
  - resetCommand
  - healthCheckCommand
  - versionCommand

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

## Usage

### Development

- Install dependencies

```sh
npm install
```

- Build application

```sh
# compile the code
npm run build
```

- Run application and restart it on changes in the code

```sh
# Start ostorage-srv backend in dev mode
npm run dev
```

### Production

```sh
# compile the code
npm run build

# run compiled server
npm start
```
