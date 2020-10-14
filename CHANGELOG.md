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
