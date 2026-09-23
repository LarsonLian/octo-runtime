import { createInterface } from "node:readline";
const reader = createInterface({input:process.stdin});
const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id,result) => send({id,result});
const emit = (method,params={}) => send({method,params:{threadId:"thread-activity",turnId:"turn-activity",...params}});
reader.on("line",line=>{
  const m=JSON.parse(line);
  if(m.method==="initialize")reply(m.id,{});
  if(m.method==="thread/start")reply(m.id,{thread:{id:"thread-activity"}});
  if(m.method==="turn/start"){
    reply(m.id,{turn:{id:"turn-activity"}});
    emit("turn/started",{turn:{id:"turn-activity"}});
    emit("item/agentMessage/delta",{threadId:"other-thread",itemId:"x",delta:"not ours"});
    emit("item/agentMessage/delta",{turnId:"old-turn",itemId:"x",delta:"not current"});
    emit("item/agentMessage/delta",{itemId:"m",delta:""});
    emit("item/unknown/heartbeat",{delta:"noise"});
    emit("item/started",{item:{id:"m",type:"agentMessage"}});
    emit("item/started",{item:{id:"m",type:"agentMessage"}});
    emit("item/agentMessage/delta",{itemId:"m",delta:"ok"});
    emit("thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:12}}});
    emit("thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:12}}});
    emit("error",{willRetry:true,message:"secret provider details"});
    emit("turn/completed",{turn:{id:"turn-activity",status:"completed"}});
  }
});
