// Setup basic express server
var express = require('express');
var app = express();
const server = require('http').createServer(app);
const port = process.env.PORT || 1437;
const secret_key = 'UxA54BBjUSbBAS6jPnxf';

var spawn = require('child_process').spawn;
var fs = require('fs');
var io = require('socket.io')(server);

spawn('ffmpeg',['-h']).on('error',function(m){
	console.error("FFMpeg not found in system cli; please install ffmpeg properly or make a softlink to ./!");
	process.exit(-1);
});

app.use(express.static('public'));

app.get('/ping', function (req, res) {
	res.send('pong');
});

app.post('/status', function (req, res) {
	var secretKey	= req.query.secretkey;
	var event		= req.query.event;
	var status		= req.query.status;
	var embed		= req.query.embed;

	if (secret_key == secretKey) {
		io.emit('status',{
			event:	event,
			status:	status,
			embed:	embed
		});
		res.send('ok');
	} else {
		res.send('error');
	}
});

io.on('connection', function(socket){
	var ffmpeg_process, feedStream=false;

	socket.emit('message','Hello from mediarecorder-to-rtmp server!');

	socket.on('config_rtmpDestination',function(m){
		if(typeof m != 'string'){
			socket.emit('fatal','rtmp destination setup error.');
			return;
		}
		var regexValidator=/^rtmp:\/\/[^\s]*$/;//TODO: should read config
		if(!regexValidator.test(m)){
			socket.emit('fatal','rtmp address rejected.');
			return;
		}
		socket._rtmpDestination=m;
		socket.emit('message','rtmp destination set to:'+m);
	});

	socket.on('config_vcodec',function(m){
		if(typeof m != 'string'){
			socket.emit('fatal','input codec setup error.');
			return;
		}
		if(!/^[0-9a-z]{2,}$/.test(m)){
			socket.emit('fatal','input codec contains illegal character?.');
			return;
		}//for safety
		socket._vcodec=m;
	});

	socket.on('start',function(m){
		if(ffmpeg_process || feedStream){
			socket.emit('fatal','stream already started.');
			return;
		}
		if(!socket._rtmpDestination){
			socket.emit('fatal','no destination given.');
			return;
		}
		var framerate = parseInt(socket.handshake.query.framespersecond);
		var audioBitrate = parseInt(socket.handshake.query.audioBitrate);
		var audioEncoding = "64k";
		if (audioBitrate == 11025) {
			audioEncoding = "11k";
		} else if (audioBitrate == 22050) {
			audioEncoding = "22k";
		} else if (audioBitrate == 44100) {
			audioEncoding = "44k";
		} else if (audioBitrate == 48000) {
			audioEncoding = "320k";
		} else if (audioBitrate == 48000) {
		    audioEncoding = "48k";
		}
		console.log(audioEncoding, audioBitrate);
		console.log('framerate on node side', framerate);
		if (framerate == 15){
            var ops = [
                '-i', '-',
                '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
                '-filter_complex', 'aresample',
                '-max_muxing_queue_size', '100000',
                // '-bufsize', '5000',
				'-b:v', '10M', '-maxrate', '10M', '-bufsize', '5M',
                '-r', '15', '-g', '30', '-keyint_min', '1',
                '-x264opts', 'keyint=1', '-crf', '10', '-pix_fmt', 'yuv420p',
                '-profile:v', 'baseline', '-level', '3',
                '-c:a', 'aac', '-b:a', audioEncoding, '-ar', audioBitrate,
                '-f', 'flv', socket._rtmpDestination,
                '-x264-params', 'ref=4',
                '-movflags', '+faststart',
                //'-vf', 'scale=640x360'
                //'-analyzeduration', '10M'
            ];
        } else {
			var ops = [
                '-i', '-',
                '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
                '-filter_complex', 'aresample',
                '-max_muxing_queue_size', '100000',
                // '-bufsize', '5000',
				'-b:v', '10M', '-maxrate', '10M', '-bufsize', '5M', 
                '-r', '' + framerate, '-g', (framerate * 2), '-keyint_min', '1',
                '-x264opts', 'keyint=1', '-crf', '10', '-pix_fmt', 'yuv420p',
                '-profile:v', 'baseline', '-level', '3',
                '-c:a', 'aac', '-b:a', audioEncoding, '-ar', audioBitrate,
                '-f', 'flv', socket._rtmpDestination,
                '-x264-params', 'ref=4',
                '-movflags', '+faststart',
                //'-vf', 'scale=640x360'
				//'-analyzeduration', '10M'
			];
		}
		/*. original params
		'-i','-',
		'-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',  // video codec config: low latency, adaptive bitrate
		'-c:a', 'aac', '-ar', '44100', '-b:a', '64k', // audio codec config: sampling frequency (11025, 22050, 44100), bitrate 64 kbits
		'-y', //force to overwrite
		'-use_wallclock_as_timestamps', '1', // used for audio sync
		'-async', '1', // used for audio sync
		//'-filter_complex', 'aresample=44100', // resample audio to 44100Hz, needed if input is not 44100
		//'-strict', 'experimental',
		'-bufsize', '1000',
		'-f', 'flv', socket._rtmpDestination
		*/
		console.log("ops", ops);
		console.log(socket._rtmpDestination);
		ffmpeg_process=spawn('ffmpeg', ops);
		console.log("ffmpeg spawned");
		feedStream=function(data){
			ffmpeg_process.stdin.write(data);
			//write exception cannot be caught here.
		}

		ffmpeg_process.stderr.on('data',function(d){
			socket.emit('ffmpeg_stderr','' + d);
		});

		ffmpeg_process.on('error',function(e){
			console.log('child process error ' + e);
			socket.emit('fatal','ffmpeg error!' + e);
			feedStream=false;
			socket.disconnect();
		});

		ffmpeg_process.on('exit',function(e){
			console.log('child process exit ' + e);
			socket.emit('fatal','ffmpeg exit!' + e);
			socket.disconnect();
		});
	});

	socket.on('binarystream',function(m){
		if(!feedStream){
			socket.emit('fatal','rtmp not set yet.');
			ffmpeg_process.stdin.end();
			ffmpeg_process.kill('SIGINT');
			return;
		}
		feedStream(m);
	});

	socket.on('disconnect', function () {
		console.log("socket disconnected!");
		feedStream=false;
		if(ffmpeg_process) {
			try{
				ffmpeg_process.stdin.end();
				ffmpeg_process.kill('SIGINT');
				console.log("ffmpeg process ended!");
			}catch(e){
				console.warn('killing ffmpeg process attempt failed...');
			}
		}
	});

	socket.on('error',function(e){
		console.log('socket.io error:' + e);
	});
});

io.on('error',function(e){
	console.log('socket.io error:' + e);
});

server.listen(port, function(){
	console.log('https and websocket listening on *:' + port);
});

process.on('uncaughtException', function(e) {
	// handle the error safely
	console.log(e);
	// Note: after client disconnect, the subprocess will cause an Error EPIPE, which can only be caught this way.
})
