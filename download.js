'use strict';
const req = require('request'),
	cheerio = require('cheerio'),
	async = require('async'),
	path = require('path'),
	fs = require('graceful-fs'),
	ProgressBar = require('progress'),
	rl = require('readline').createInterface({
		input: process.stdin,
		output: process.stdout
	});

var jar = req.jar();
const request = req.defaults({'followRedirect': false, 'timeout': 10 * 1000, 'jar': jar});

const OUTPUT_DIR = "output";

if(process.argv.length < 3 || isNaN(process.argv[2])) {
	console.log("Usage: node download.js <titleId>");
	process.exit(1);
}

if (process.platform === "win32") {
	rl.on("SIGINT", function () {
		process.emit("SIGINT");
	});
}

var terminate = false;
// To gracefully stop, logging which toon is not downloaded
process.on("SIGINT", function () {
	terminate = true;
});

var titleId = process.argv[2];// | 0;

var doneCount = 0;
var bar;
function tickProgress() {
	//console.log(doneCount);
	//bar.tick(++doneCount);
	bar.tick(1);
}

/*function applyCookie(setCookieHeader) {
	if(!setCookieHeader) return;
	if(typeof setCookieHeader === 'string') {
		var cookies = setCookieHeader.split(/, ?/g);
		for(var cookie of cookies) {
			jar.setCookie(request.cookie(cookie), "http://comic.naver.com");
		}
	} else {
		for(var cookie of setCookieHeader) {
			applyCookie(cookie);
		}
	}
}*/

// Generator function for parallel task
function* webtoonTaskGenerator(titleId, last) {
	// runs through the list, from 1 to last(inclusively), and generate(yield) async function
	var doingAuthInput = false;
	for(let i = 1; i <= last; i++) {
		yield function webtoonGetter(callback) {
			if(terminate) {
				return callback(null, false);
			}
			var url = `http://comic.naver.com/webtoon/detail.nhn?titleId=${titleId}&no=${i}`;
			request(url, (err, res, html) => {
				if(err) {
//					console.error("ERROR:", err);
					return callback(err);
				}

//				applyCookie(res.headers['set-cookie']);

				if(res.statusCode === 200) {
					var $ = cheerio.load(html);
					var $images = $(".wt_viewer img[id^=content_image_]");

					if(terminate) {
						return callback(null, {
							'no': i,
							'title': $(".view h3").text().trim(),
							'thumb': null,
							'images': [].fill(false, 0, $images.length)
						});
					}

					fs.mkdir(path.resolve(OUTPUT_DIR, titleId, i+""), (err) => {
						if(err && err.code != "EEXIST") {
							return callback(err);
						}

						if(terminate) {
							return callback(null, {
								'no': i,
								'title': $(".view h3").text().trim(),
								'thumb': null,
								'images': [].fill(false, 0, $images.length)
							});
						}

						async.parallel([
							(callback) => {
								var thumb = $("#comic_move .item > .on img").attr('src');
								var filename = "thumb" + path.extname(thumb);
								request.get(thumb)
									.pipe(fs.createWriteStream(path.resolve(OUTPUT_DIR, titleId, i+"", filename)))
									.on('finish', () => {
										callback(null, filename);
									})
									.on('error', callback);
							},
							(callback) => {
								async.parallel([...imageTaskGenerator($images, url, path.resolve(OUTPUT_DIR, titleId, i+""))], callback);
							}
						], (err, results) => {
							tickProgress();
							results[i]
							callback(err, {
								'no': i,
								'title': $(".view h3").text().trim(),
								'thumb': results[0],
								'images': results[1]
							});
						});
					});
				} else if(res.statusCode == 302) {
					if(!doingAuthInput) {
						doingAuthInput = true;
						console.log("Failed to load toon#" + i + ", trying with user auth info can help.");
						rl.question("NID_AUT: ", (aut) => {
							rl.question("NID_SES: ", (ses) => {
								jar.setCookie(request.cookie("NID_AUT=" + aut), "http://comic.naver.com");
								jar.setCookie(request.cookie("NID_SES=" + ses), "http://comic.naver.com");
								doingAuthInput = false;
								webtoonGetter(callback); // Retry with session information
							})
						});
					} else {
						//console.log("Failed to load toon#" + i + ". Waiting until input is done...");
						(function waitInputDone() {
							if(doingAuthInput) {
								async.setImmediate(waitInputDone);
							} else {
								webtoonGetter(callback);
							}
						})();
					}
				} else {
					callback(new Error("Unknown response code " + res.statusCode + " while requesting toon#" + i));
				}
			});
		};
	}
}

/*const MIME_EXT = {
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/x-icon": ".ico",
	"image/jpeg": ".jpg",
	"image/pjpeg": ".jpg",
	"image/png": ".png",
	"image/tiff": ".tif",
	"image/x-tiff": ".tif"
};*/

function* imageTaskGenerator(items, referer, dir) {
	//items.each((i, elem) => {
	for(let i = 0; i < items.length; i++) {
		let elem = items[i];
//		console.log("ELEM: ", elem);
		yield (callback) => {
			if(terminate) {
				return callback(null, false);
			}

			async.retry({times: 10, interval: 100}, function getImage(callback) {
				if(terminate) {
					return callback(null, false);
				}

				var called = false;
				var cb = function(err, res) {
					if(!called) callback(err, res);
					called = true;
				};

				var filename = (i+1) + path.extname(elem.attribs.src);
				var target = path.resolve(dir, filename);

				fs.stat(target, (err, stat) => {
					if(err && err.code != "ENOENT") {
						return callback(err);
					}
					var options = {
						uri: elem.attribs.src,
						headers: {
							'Referer': referer
						}
					};

					if(!err) {
						request.head(options)
							.on('error', cb)
							.on('response', (response) => {
//								applyCookie(response.headers['set-cookie']);

								if(stat.size != response.headers['content-length']) {
									downloadImage();
								} else {
									cb(null, filename);
								}
							});
					} else {
						downloadImage();
					}

					function downloadImage() {
						request.get(options)
							.on('error', cb)
							.on('response', (response) => {
///								applyCookie(response.headers['set-cookie']);
				
								if(response.statusCode == 200) {
									response
										.pipe(fs.createWriteStream(target))
										.on('finish', () => {
											cb(null, filename);
										})
										.on('error', cb);
								} else {
									if(response.statusCode == 304) { // not modified
										//console.log("Cached");
										// leave as-is
										cb(null, filename);
									} else {
										cb(new Error("Unknown status code " + response.statusCode + ", while downloading " + JSON.stringify(options)));
									}
								}
							});
					}
				});
			}, (err, res) => {
				if(err) {
					console.error(err);
					callback(null, false);
				} else {
					callback(null, res);
				}
			});
		};
	}
}

(function start(callback) {
	var start = Date.now();
	async.waterfall([
		// Last toon number guesser, replaced by toon list lookup
		/*
		function initPair(callback) {
			callback(null, {lower: 1, upper: 50});
		},
		// Doubles upper bound, checks if the toon exists by requesting http.
		function findUpperBound(bin, callback) {
			if(terminate) {
				callback(true);
				return;
			}
			
			// use HEAD method, as body is not used
			request.head(`http://comic.naver.com/webtoon/detail.nhn?titleId=${titleId}&no=${bin.upper}`)
				.on('response', (res) => {
					if(res.statusCode === 200) {
						bin.upper *= 2;
						findUpperBound(bin, callback);
					} else if(res.statusCode === 302) {
						callback(null, bin);
					} else {
						callback(new Error("Unknow response code " + res.statusCode + " while requesting toon#" + upper));
					}
				});
		},
		// Searchs the real last toon by
		function binSearch(bin, callback) {
			if(terminate) {
				callback(true);
				return;
			}
			
			var mid = Math.floor((bin.lower + bin.upper) / 2);
			if(bin.lower > bin.upper) {
				callback(null, mid);
				return;
			}
			request.head(`http://comic.naver.com/webtoon/detail.nhn?titleId=${titleId}&no=${mid}`)
				.on('response', (res) => {
					if(res.statusCode === 200) {
						bin.lower = mid + 1;
						binSearch(bin, callback);
					} else if(res.statusCode === 302) {
						bin.upper = mid - 1;
						binSearch(bin, callback);
					} else {
						callback(new Error("Unknow response code " + res.statusCode + " while requesting toon#" + mid));
					}
				});
		},*/
		
		// Find the last number of the toon by looking at the list
		function lookupList(callback) {
			if(terminate) {
				return callback(true);
			}

			request(`http://comic.naver.com/webtoon/list.nhn?titleId=${titleId}`, (err, res, html) => {
				if(err) {
					return callback(err);
				}
				if(terminate) {
					return callback(true);
				}

				var $ = cheerio.load(html);

				var $info = $("div.comicinfo");

				var thumb = $info.find(".thumb img").attr('src');

				var title = $info.find("h2").text().replace(/^\s\s*/gm, "").replace(/\s*\s$/gm, "");
				var writer = $info.find("h2 .wrt_nm").text().replace(/^\s\s*/gm, "").replace(/\s*\s$/gm, "");
				title = title.replace(new RegExp(writer + "$"), "");

				var desc = $info.find("p").html();//.replace(/<br[^>]*>/gi, "\n").replace(/^\s\s*/gm, "").replace(/\s*\s$/gm, "");

				var info = {
					'thumbnail': thumb,
					'title': title,
					'author': writer,
					'description': desc
				};

				var $link = $(".webtoon table.viewList tr td.title a");
				for(var param of $link.attr("href").split(/[\?&]/)) {
					var spl = param.split('=');
					if(spl.length > 1 && spl[0] == 'no') {
						callback(null, {'info': info, 'last': spl[1]|0});
						return;
					}
				}
				callback(new Error("Webtoon list not found"));
			});
		},

		function loadWebtoon(toon, callback) {
			bar = new ProgressBar("Downloading: [:bar] :current/:total(:percent) :etas", {
				complete: ":",
				incomplete: ".",
				width: 42,
				total: toon.last
			});
			bar.tick(0);

			if(terminate) {
				return callback(true);
			}
			
			async.series([
				(callback) => {
					fs.mkdir(OUTPUT_DIR, (err) => {
						if(err && err.code != 'EEXIST') {
							callback(err);
						} else {
							callback(null);
						}
					});
				},
				(callback) => {
					fs.mkdir(path.resolve(OUTPUT_DIR, titleId), (err) => {
						if(err && err.code != 'EEXIST') {
							callback(err);
						} else {
							callback(null);
						}
					});
				},
				(callback) => {
					async.parallelLimit([...webtoonTaskGenerator(titleId, toon.last)], 10, (err, results) => {
						if(err) {
							callback(err);
						} else {
							toon['result'] = results;//[results.length-1];
							callback(null, toon);
						}
					});
				}
			], (err, results) => {
				// TODO
				callback(err, results[2]);
			});
		},

		function writeList(toon, callback) {
			async.parallel([
				(callback) => {
					request.get(toon.info.thumbnail)
						.pipe(fs.createWriteStream(path.resolve(OUTPUT_DIR, titleId, "thumb" + path.extname(toon.info.thumbnail))))
						.on('finish', () => {
							callback(null);
						})
						.on('error', (e) => {
							callback(e);
						});
				},

				(callback) => {
					fs.readFile("template.html", 'utf8', function(err, template) {
						if(err) {
							callback(err);
						} else {
							var $ = cheerio.load(template);
							$("#title").text(toon.info.title);
							$("#author").text(toon.info.author);
							$("#description").html(toon.info.description);

							var $list = $("#list .body");
							for(var result of toon.result) {
								$list.append($(`<tr data-no="${result.no}"><td class="thumb"><img src="${result.no}/${result.thumb}"></td><td class="no">${result.no}</td><td class="title">${result.title}</td></tr>`));
							}

							fs.writeFile(path.resolve(OUTPUT_DIR, titleId, "view.html"), $.html(), 'utf8', callback);
						}
					});
				},

				(callback) => {
					fs.writeFile(path.resolve(OUTPUT_DIR, titleId, "filelist.js"), "var files=" + JSON.stringify(toon.result), 'utf8', callback);
				}

			], (err, results) => {
				callback(err, results);
			});
		}
	], function(err, toon) {
		if(terminate) console.log("Task aborted");
		if(err) throw err;

		var successful = true;
		for(var i in toon.result) {
			if(!toon.result[i]) {
				successful = false;
				break;
			}
			for(var j in toon.result[i]) {
				if(!toon.result[i][j]) {
					successful = false;
					break;
				}
			}
			if(!successful) break;
		}

		var end = Date.now();
		if(successful) {
			console.log();
			console.log("Download finished successfully in " + (end - start) / 1000 + " sec.");
			callback(true);
		} else {
			console.log();
			for(var i in toon.result) {
				process.stdout.write(((i|0)+1) + ": ");
				for(var j in toon.result[i]) {
					process.stdout.write(toon.result[i][j]? '■' : '□');
				}
				process.stdout.write('\n');
			}
			callback(false);
		}
	});
})((successful) => {
	process.exit(0);
});
