// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

const fs=require('fs');
const buf=fs.readFileSync(process.argv[2]);
const kw=/replicat|RepIndex|NetField|bunch|Bunch|actor channel|ActorChannel|RemoteRole|Unknown actor|ProcessRemote|field index|replication index|Reading actor|NetConnection|Mismatched|spawn.*actor/i;
const seen=new Set();
// UTF-16LE strings
let s='';
for(let i=0;i+1<buf.length;i+=2){const c=buf[i],h=buf[i+1];if(h===0&&c>=0x20&&c<0x7f){s+=String.fromCharCode(c);}else{if(s.length>=5&&kw.test(s))seen.add(s);s='';}}
[...seen].sort().forEach(x=>console.log(JSON.stringify(x)));
