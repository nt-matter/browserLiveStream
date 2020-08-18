#!/bin/bash
env
apt-get update
apt-get upgrade -y
apt-get install ffmpeg -y
npm install
node server.js
