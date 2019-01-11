# ostorage-srv

A RestoreCommerce microservice for abstracting object storage through [grpc](https://grpc.io/docs/).
It uses an [AWS SDK](https://www.npmjs.com/package/aws-sdk) client for connecting to an object storage framework. Currently, objects are stored using [minio](https://www.minio.io/) for local development within a Docker network and [rook](https://rook.io/) on a Kubernettes production environment.
Asynchronous communication is performed through [Kafka](https://kafka.apache.org/) using the RestoreCommerce [kafka-client](https://github.com/restorecommerce/kafka-client).

## gRPC Interface

This microservice exposes the following gRPC endpoints:

`io.restorecommerce.ostorage.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Put | `io.restorecommerce.ostorage.Object` | `Url` | Return Url of File. |
| Get | `io.restorecommerce.ostorage.GetRequest` | `io.restorecommerce.ostorage.Object` | Get an object. |
| Delete | `io.restorecommerce.ostorage.DeleteRequest` | `google.protobuf.Empty` | Delete an object by its key and bucket. |
|List | `io.restorecommerce.ostorage.List` | `io.restorecommerce.ostorage.FilesInformation` | Return a list of files information. |


`io.restorecommerce.ostorage.Object`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object should be mapped to. |
| key | string | required | Object key. |
| object | bytes | required | Blob. |
| meta | [io.restorecommerce.meta.Meta](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | required | metadata attached to file.|
| fileName | string | required | Filename. |
| url | string | required | url of saved file. |
| prefix | string | required | Prefix,used to create folder inside aws storage. |

`io.restorecommerce.ostorage.GetRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object should be mapped to. |
| key | string | required | Object key. |
| flag | boolean | required | flag to get only metadata of object. |

`io.restorecommerce.ostorage.DeleteRequest`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | Bucket to which the object should be mapped to. |
| key | string | required | Object key. |

`io.restorecommerce.ostorage.List`
| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | optional | If bucket name provied it will return its files otherwise it will return all files. |

`io.restorecommerce.ostorage.FilesInformation`
| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| bucket | string | required | bucket name. |
| file_name | string | required | file name. |
| meta | [io.restorecommerce.meta.Meta](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | required | meta information of object.|


## Kafka Events

This microservice subscribes to the following Kafka events by topic:
- io.restorecommerce.command
  - restoreCommand
  - resetCommand
  - healthCheckCommand
  - versionCommand

## Chassis Service

This service uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base module for [restorecommerce](https://github.com/restorecommerce) microservices, in order to provide the following functionalities:
- exposure of all previously mentioned gRPC endpoints
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- Kafka offset value storage at regular intervals to [Redis](https://redis.io/).

## Usage

See [tests](test/).


**Note**: although any kind of gRPC client can be used to connect to these endpoints, the tests make use of the [grpc-client](https://github.com/restorecommerce/grpc-client),
a [restorecommerce](https://github.com/restorecommerce) module which allows an application to connect to multiple gRPC endpoints with custom middleware, loadbalancing and retry/timeout support.
