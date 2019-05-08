const Imap = require('imap'),
    moment = require("moment"),
    inspect = require('util').inspect;
const config = require("./conf.json");
const pattern = config.bodyExclusions
                        .map((item) => `(${item.replace("/", "\\/").replace(":", "\\:").replace(".", "\\.")})`)
                        .reduce((acc, curr, idx) => acc += curr + (config.bodyExclusions.length-1 === idx ? "" : "|"), "");
const spamRegex = new RegExp(pattern, "gm");
let imap = new Imap(config.imapAccount);

function openInbox(cb) {
    imap.openBox('INBOX', false, cb);
}

let uidsToMove = [];

imap.once('ready', function() {
    openInbox(function(err, box) {
        if (err) throw err;

        imap.search([ 'ALL', ['SINCE', moment().format("LL")]], function(err, results) {
            if (err) throw err;
            console.log("results", results);
            if (results && results.length > 0) {
                let f = imap.fetch(results, {
                    bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', "TEXT"],
                    struct: true
                });
                f.on('message', function (msg, seqno) {
                    let prefix = '(#' + seqno + ') ';
                    let from = "";
                    let body = "";
                    let uid = -1;
                    msg.on('body', function (stream, info) {
                        if (info.which === 'TEXT')
                            console.log(prefix + 'Body [%s] found, %d total bytes', inspect(info.which), info.size);
                        let buffer = '', count = 0;
                        stream.on('data', function(chunk) {
                            count += chunk.length;
                            buffer += chunk.toString('utf8');
                        });
                        stream.once('end', function() {
                            if (info.which !== 'TEXT') {
                                let header = Imap.parseHeader(buffer);
                                console.log(`${prefix}Parsed header: [${header.date}] ${header.from} => ${header.to} : ${header.subject}`);
                                from = header.from[0];
                            }
                            else {
                                //console.log(`${prefix} Body Finished : ${buffer.substr(0, 500)}`);
                                body = buffer;
                            }
                        });
                    });
                    msg.once('attributes', function (attrs) {
                        uid = attrs.uid;
                    });
                    msg.once('end', function () {
                        let results = spamRegex.exec(body);
                        if (results) {
                            let isSenderApproved = checkFromWhiteList(from);
                            if (isSenderApproved) {
                                console.log(`${prefix}Finished : contains ${results[0]} but sender ${from} is approved`);
                            } else {
                                console.log(`${prefix}Finished : SPAM to move, body contains ${results[0]}, sender ${from}`);
                                uidsToMove.push(uid);
                            }
                        } else {
                            console.log(prefix + 'Finished');
                        }
                    });
                });
                f.once('error', function (err) {
                    console.log('Fetch error: ' + err);
                });
                f.once('end', function () {
                    console.log('Done fetching all messages!');
                    openInbox((err, box)=> {
                        if (err) throw err;
                        try {
                            imap.move(uidsToMove, config.spamFolder, (err) => {
                                if (err) throw err;
                                console.log(`${uidsToMove.join(",")} Moved to ${config.spamFolder}`);
                                imap.end();
                            });
                        } catch (err) {
                            console.error(`Can't move ${uidsToMove.join(",")}, reason :`, err);
                        }
                    });

                });
            } else {
                imap.end();
            }
        });
    });
});

imap.once('error', function(err) {
    console.log(err);
});

imap.once('end', function() {
    console.log('Connection ended');
});

function checkFromWhiteList(from) {
    return config.whiteList.map((item)=> from.includes(item)).reduce((acc, curr) => acc||curr, false);
}

imap.connect();