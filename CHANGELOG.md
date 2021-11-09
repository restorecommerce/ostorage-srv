## 0.2.11 (November 8th, 2021)

- added check condition for object meta

## 0.2.10 (November 8th, 2021)

- rename sourcePath to sourceObject for move rpc

## 0.2.9 (November 5th, 2021)

- fix operation status response for move operation

## 0.2.8 (November 5th, 2021)

- fix list filter

## 0.2.7 (November 5th, 2021)

- up acs-client dep

## 0.2.6 (November 5th, 2021)

- added move api and added prefix and max_keys for list api

## 0.2.5 (November 3rd, 2021)

- store ACL data into redis instead of object metadata in S3 (due to header size limitation)

## 0.2.4 (October 7th, 2021)

- up acs-client

## 0.2.3 (October 7th, 2021)

- up protos to include ACL in meta proto

## 0.2.2 (September 21st, 2021)

- up RC dependencies

## 0.2.1 (September 13th, 2021)

- fix kafka production port
- up dependencies

## 0.2.0 (August 23rd, 2021)

- migrated to latest grpc-client
- migraged kafka-client to kafkajs
- chassis-srv using the latest grpc-js and protobufdef loader
- filter changes (removed google.protobuf.struct completely and defined nested proto structure)
- added status object to each item and also overall operation_status

## 0.1.29 (July 28th, 2021)

- fix meta for copy operation (when null)

## 0.1.28 (July 28th, 2021)

- modified `copy` operation to support `acl` access-control list
- updated logger

## 0.1.27 (July 22nd, 2021)

- modified checkAcessRequest to not add entity (to make isAllowed req for `get` Read requests)
- modified `put` api to read the bucket, key and meta information once
- updated dependencies

### 0.1.26 (June 15th, 2021)

- updated protos for osotrage (to include subject for OstorageMessage - event emitted on upload / download)
- added subject of requestor when emitting objectUploaded / objectDownloadRequested event

### 0.1.25 (April 26th, 2021)

- improved error handling for `get` api for s3 stream errors
- updated dependencies

### 0.1.24 (April 7th, 2021)

- fix log message

### 0.1.23 (March 25th, 2021)

- fix typo in production config

### 0.1.22 (March 19th, 2021)

- migrate from redis to ioredis
- updated dependencies

### 0.1.21 (March 15th, 2021)

- fixed get / download api for piping the AWS response stream directly to grpc response stream

### 0.1.20 (March 11th, 2021)

- updated dependencies.

### 0.1.19 (February 24th, 2021)

- fix unmarshalling options data for object upload
- updated logger and protos
- updated node to 14.5.5 and updated npm

### 0.1.18 (February 19th, 2021)

- fix acs-srv production port

### 0.1.17 (February 15th, 2021)

- update put and get api for request and response streaming (to handle back pressure for `put` and pipe request stream for `get`)
- updated chassis-srv and grpc-client (fix for request and response streaming)
- updated tests

### 0.1.16 (January 28th, 2021)

- fixed put api for error handling

### 0.1.15 (December 17th, 2020)

- handle error when object meta is not found

### 0.1.14 (December 4th, 2020)

- protos (last_login updated on token)

### 0.1.13 (December 4th, 2020)

- fix acs-client for filter boolean condition

### 0.1.12 (December 4th, 2020)

- up acs-client which includes fix to set unauthenticated to true when subject does not exist

### 0.1.11 (December 2nd, 2020)

- fix docker image permissions

### 0.1.10 (December 1st, 2020)

- fix production redis auth cache address

### 0.1.9 (November 19th, 2020)

- update to remove subject-id and pass token to acs-client
- updated dependencies

### 0.1.8 (November 5th, 2020)

- fix copy operation to store options data in meta object
- removed listObjects check for delete operation and fix list objects when no scoping defined in rules

### 0.1.7 (October 19th, 2020)

- updated chassis-srv
- add acs-srv readiness check
- updated acs-client

### 0.1.6 (October 14th, 2020)

- add new grpc healthcheck with readiness probe
- listen on 0.0.0.0 for grpc port
- changes to store data (google.protobuf.Any meta data) to metaObject and also the subject_id, removed duplicate object tags reading
- up dependencies

### 0.1.5 (October 9th, 2020)

- up acs-client includes fix for validation of subID and token

### 0.1.4 (October 3rd, 2020)

- restructured protos
- updated acs-client

### 0.1.3 (September 9th, 2020)

- updated acs-client and protos
- fix not to read subject from redis

### 0.1.2 (Auguest 27th, 2020)

- healthcheck fix, updated dependencies

### 0.1.1 (Auguest 18th, 2020)

- updated logger and node version

### 0.1.0 (July 29th, 2020)

- initial release
