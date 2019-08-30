FROM node:12.4.0-stretch

# Install dependencies
RUN apt-get update && apt-get install -y libc6-dev

## CREATE APP USER ##
# Create the home directory for the new app user.
RUN mkdir -p /home/app

# Create an app user so our application doesn't run as root.
RUN groupadd -r app &&\
    useradd -r -g app -d /home/app -s /sbin/nologin -c "Docker image user" app

# Create app directory
ENV HOME=/home/app
ENV APP_HOME=/home/app/ostorage-srv

# Install global dependencies
RUN npm install -g typescript

## SETTING UP THE APP ##
WORKDIR $APP_HOME

# Chown all the files to the app user.
RUN chown -R app:app $HOME

# Change to the app user.
USER app

# Set config volumes
VOLUME $APP_HOME/cfg

# Install Dependencies
COPY --chown=app package.json $APP_HOME
COPY --chown=app package-lock.json $APP_HOME
RUN npm install

# Bundle app source
COPY --chown=app . $APP_HOME
RUN npm run build

EXPOSE 50051
CMD [ "npm", "start" ]

# To build the image:
# docker build -t restorecommerce/ostorage-srv .
#
# To create a container:
# docker create --name ostorage-srv --net restorecms_default restorecommerce/ostorage-srv
#
# To run the container:
# docker start ostorage-srv
