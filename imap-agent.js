const Imap = require('imap'),
    moment = require("moment"),
    inspect = require('util').inspect,
    path = require("path"),
    fs = require('fs');

// Get config from file and create regex for analyze
const config = require("./conf.json");
const pattern = config.bodyExclusions
                        .map((item) => `(${item.replace("/", "\\/").replace(":", "\\:").replace(".", "\\.")})`)
                        .reduce((acc, curr, idx) => acc += curr + (config.bodyExclusions.length-1 === idx ? "" : "|"), "");
const spamRegex = new RegExp(pattern, "gm");

// Load Mail Ids already analyzed from file
let mailAnalyzed = [];
const todaysFile =  path.join(__dirname, `/data/${moment().format("YYYYMMDD")}.json`);
try {
    if (fs.existsSync(todaysFile)) {
        mailAnalyzed = require(todaysFile);
    } else {
        console.log("Today's file not found")
    }
} catch(err) {
    console.error(err)
}
const auditFile = path.join(__dirname, `./data/audit-${moment().format("YYYYMMDD")}.txt`);

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
                let filteredResults = results.filter((uid) => !mailAnalyzed.includes(uid));
                console.log("filtered results", filteredResults);
                if (filteredResults && filteredResults.length > 0) {
                    let f = imap.fetch(filteredResults, {
                        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', "TEXT"],
                        struct: true
                    });
                    f.on('message', function (msg, seqno) {
                        let prefix = '(#' + seqno + ') ';
                        let from = "";
                        let body = "";
                        let subject = "";
                        let date = "";
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
                                    date = header.date;
                                    subject = header.subject;
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
                            let spamMatches;
                            let base64Count =(body.match(/Content-Transfer-Encoding: base64/g)||[]).length;
                            if (base64Count===1) {
                                console.log(`${prefix}Base64 encoded`);
                                let start = body.indexOf("Content-Transfer-Encoding: base64")+33;
                                let partialBody = body.substring(start).trim();
                                let end = partialBody.indexOf("\r\n\r\n");
                                let bodyToConvert = partialBody.substring(0, end).split("\r\n").join("");
                                let convertedBody = Buffer.from(bodyToConvert, 'base64').toString('utf8');
                                spamMatches = spamRegex.exec(convertedBody);
                            } else if (base64Count > 1) {
                                console.log(`${prefix}Multiple parts are base64 encoded`);
                            } else {
                                spamMatches = spamRegex.exec(body);
                            }

                            if (spamMatches) {
                                let isSenderApproved = checkFromWhiteList(from);
                                if (isSenderApproved) {
                                    console.log(`${prefix}Finished : contains ${spamMatches[0]} but sender ${from} is approved`);
                                    appendToAuditFile(`[${uid}] ${prefix} SEND AT : ${date}, FROM ${from}, SUBJECT "${subject}", ${base64Count > 0 ? "BASE64 ("+ base64Count +") " : ""}BODY CONTAINS ${spamMatches[0]} but sender is approved`);
                                    mailAnalyzed.push(uid);
                                } else {
                                    console.log(`${prefix}Finished : SPAM to move, body contains ${spamMatches[0]}, sender ${from}`);
                                    appendToAuditFile(`[${uid}] ${prefix} SEND AT : ${date}, FROM ${from}, SUBJECT "${subject}", ${base64Count > 0 ? "BASE64 ("+ base64Count +") " : ""}BODY CONTAINS ${spamMatches[0]} AND IS MOVED`);
                                    uidsToMove.push(uid);
                                }
                            } else {
                                console.log(prefix + 'Finished');
                                appendToAuditFile(`[${uid}] ${prefix} SEND AT : ${date}, FROM ${from}, SUBJECT "${subject}", ${base64Count > 0 ? "BASE64 ("+ base64Count +") " : ""}BODY CLEAN`);
                                mailAnalyzed.push(uid);
                            }
                        });
                    });
                    f.once('error', function (err) {
                        console.log('Fetch error: ' + err);
                    });
                    f.once('end', function () {
                        console.log('Done fetching all messages!');
                        if (uidsToMove.length > 0) {
                            try {
                                imap.move(uidsToMove, config.spamFolder, (err) => {
                                    if (err) throw err;
                                    console.log(`${uidsToMove.join(",")} Moved to ${config.spamFolder}`);
                                    imap.end();
                                });
                            } catch (err) {
                                console.error(`Can't move ${uidsToMove.join(",")}, reason :`, err);
                                appendToAuditFile(`Failed to move`);
                                imap.end();
                            }
                        } else {
                            imap.end();
                        }
                        fs.writeFileSync(todaysFile, JSON.stringify(mailAnalyzed));
                    });
                } else {
                    imap.end();
                }
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

function appendToAuditFile(line){
    fs.appendFileSync(auditFile, moment().format("HH:mm:ss") + " " + line + "\r\n");
}

imap.connect();