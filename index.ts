import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {sha256} from 'js-sha256';
//Some environment varaibles
const DOMAIN='https://arcwiki.mcd.blue/';
const INDEX=`${DOMAIN}index.php?`;
const API=`${DOMAIN}api.php`;
const CACHE_FOLDER='/tmp/jscache';
const RATE_LIMIT=20;
const RATING_CLASS_MAP={
	0:'Past',
	1:'Present',
	2:'Future',
	3:'Beyond',
	4:'Eternal',
};
//The definition of Informations, containing name (as wiki title), ratingClass, rating and notes
type SongInfo=Record<string,{
		ratingClass:number;
		rating:number;
		ratingPlus?:boolean;
		notes:number|null;
}[]>
const songInfo:SongInfo={};
//Mkdir if not exists
if(!fs.existsSync(CACHE_FOLDER)){
	await fs.promises.mkdir(CACHE_FOLDER,{recursive:true});
	console.log(`Created directory ${CACHE_FOLDER}`);
}
//If fetch fails, retry at most twice
async function fetchWithRetry(fn:()=>Promise<string>,retries=2):Promise<string>{
	let lastError:any;
	for(let attempt=0;attempt <=retries+1;attempt++){
		try{
			return await fn();
		}catch(error){
			lastError=error;
			if(attempt>retries){
				throw new Error(`Failed after ${retries+1} attempts: ${error}`);
			}
		}
	}
	throw lastError;
}
//Common part of jsonFetch and pageFetch
async function fetchCommon(prefix,params,fn:()=>Promise<string>):Promise<string>{
	const sha=sha256.create().update(JSON.stringify([prefix,params])).hex();
	const filename=path.join(CACHE_FOLDER,sha);
	//Check cache in CACHE_FOLDER
	if(fs.existsSync(filename)){
		const stat=await fs.promises.stat(filename);
		if(stat.size>0){
			let contents:string=await fs.promises.readFile(filename,{encoding:'utf8'});
			return Promise.resolve(contents);
		}
	}
	console.log(`Lack of ${params.params.title} in ${CACHE_FOLDER}, fetching...`);
	const contents:string=await fetchWithRetry(fn);
	fs.writeFile(filename,contents,'utf8',(err)=>{
		if(err)
			throw err;
		console.log(`Cached ${filename}`);
	});
	return Promise.resolve(contents);
}
//Fetch a specific json according to `prefix` and `params`
async function jsonFetch(prefix,params):Promise<string>{
	return fetchCommon(prefix,params,async()=>{
		const response=await axios.get(prefix,params);
		if(typeof response.data==='object'){
			return JSON.stringify(response.data);
		}else{
			throw new Error(`response.data of ${params.params.title} is incorrect: ${response}`);
		};
	});
}
//Fetch a specific page according to `prefix` and `params`
async function pageFetch(prefix,params):Promise<string>{
	return fetchCommon(prefix,params,async()=>{
		const response=await axios.get(prefix,params);
		if(typeof response.data==='string'){
			return response.data;
		}else{
			throw new Error(`response of ${params.params.title} is incorrect: ${response}`);
		};
	});
}
//Wait for Songlist.json and Transision.json
const [songlist,transition]=(await Promise.all([
	jsonFetch(INDEX,{params:{
		title:'Template:Songlist.json',
		action:'raw',
	}}),
	jsonFetch(INDEX,{params:{
		title:'Template:Transition.json',
		action:'raw',
	}}),
])).map(s=>JSON.parse(s));
//Parse name and rating info from songlist
songlist['songs']?.forEach((song)=>{
	//particle arts is deleted
	if(song.deleted){
		return;
	}
	let name:string=undefined;
	if(song.title_localized?.en){
		name=song.title_localized.en;
	}else{
		console.error(`Warning: ${song.id} have no valid name`);
	}
	if(transition['songNameToDisplayName']?.[name]){
		name=transition['songNameToDisplayName'][name];
	}
	if(transition['sameName']?.[name]){
		name=transition['sameName'][name][song.id];
	}
	//`Last` will be hard coded
	if(name==='Last'){
		return;
	}
	if(!songInfo[name]){
		songInfo[name]=[];
	}
	if(song.difficulties){
		song.difficulties.forEach((diff)=>{
			if(typeof diff.ratingClass!=='number'||typeof diff.rating!=='number'){
				console.error(`Warning: ${song.id} have no valid difficuilty`);
				return;
			}
			if(diff.ratingPlus){
				songInfo[name].push({ratingClass:diff.ratingClass,rating:diff.rating,ratingPlus:diff.ratingPlus,notes:null});
			}else{
				songInfo[name].push({ratingClass:diff.ratingClass,rating:diff.rating,notes:null});
			}
		});
	}else{
		console.error(`Warning: ${song.id} have no valid difficulies`);
	}
});
//Concurrently fetching pages according to title
class TaskQueue{
	private title:string|null=null;
	static id:number=0;
	static songNames:string[]=Object.keys(songInfo);
	static promises:Promise<void>[]=[];
	constructor(){
		if(TaskQueue.id <TaskQueue.songNames.length){
			this.title=TaskQueue.songNames[TaskQueue.id];
			TaskQueue.id++;
		}
	};
	async run():Promise<void>{
		if(this.title===null||this.title==='')
			return;
		try{
			const content=await pageFetch(INDEX,{params:{
				title:this.title,
				action:'raw',
			}});
			const p=new TaskQueue().run();
			if(p){
				TaskQueue.promises.push(p);
			}
			const pastNote=Number(content.match(/\|PastNote=(.*?)[\|\}]/s)?.[1].trim());
			const presentNote=Number(content.match(/\|PresentNote=(.*?)[\|\}]/s)?.[1].trim());
			const futureNote=Number(content.match(/\|FutureNote=(.*?)[\|\}]/s)?.[1].trim());
			const beyondNote=Number(content.match(/\|BeyondNote=(.*?)[\|\}]/s)?.[1].trim());
			const eternalNote=Number(content.match(/\|EternalNote=(.*?)[\|\}]/s)?.[1].trim());
			const ratingClassNotes=[pastNote,presentNote,futureNote,beyondNote,eternalNote];
			ratingClassNotes.forEach((notes,i)=>{
				if(Number.isNaN(notes))
					return;
				songInfo[this.title]?.forEach((piece)=>{
					if(piece.ratingClass===i){
						piece['notes']=notes;
					}
				});
			});
		}catch(err){
			console.log(err);
			const p=new TaskQueue().run();
			if(p){
				TaskQueue.promises.push(p);
			}
		}
	}
}
for(let i=0;i <RATE_LIMIT;i++){
	TaskQueue.promises.push(new TaskQueue().run());
}
//`Last` is hard coded
songInfo['Last']=[
	{ratingClass:0,rating:4,notes:680},
	{ratingClass:1,rating:7,notes:781},
	{ratingClass:2,rating:9,notes:831},
	{ratingClass:3,rating:9,notes:888},
	{ratingClass:3,rating:9,ratingPlus:true,notes:790},
];
type SongItem={
	name:string;
	ratingClass:number;
	rating:number;
	ratingPlus?:boolean;
	notes:number|null;
}
while(TaskQueue.id <TaskQueue.songNames.length||TaskQueue.promises.length>0){
	const first=TaskQueue.promises.shift();
	await first;
}
const songItem:SongItem[]=Object.entries(songInfo).flatMap(([name,arr])=>
	arr.map(({ratingClass,rating,ratingPlus,notes})=>({
		name,ratingClass,rating,ratingPlus,notes
	}))
);
songItem.sort((l,r)=>{
	if(l.rating <r.rating)
		return -1;
	if(l.rating>r.rating)
		return 1;
	if(!l.ratingPlus&&r.ratingPlus)
		return -1;
	if(l.ratingPlus&&!r.ratingPlus)
		return 1;
	if(l.notes <r.notes)
		return -1;
	if(l.notes>r.notes)
		return 1;
	return 0;
});
const groupMap=new Map<string,SongItem[]>();
for(const item of songItem){
	const key=`${item.rating}${item.ratingPlus?'+':''}`;
	if(!groupMap.has(key)){
		groupMap.set(key,[]);
	}
	groupMap.get(key)!.push(item);
}
type ResultInfo=Record<string,{
	ratingFull:string;
	ratingClass:string;
	notes:number;
	max?:boolean;
	min?:boolean;
}[]>
const resultInfo:ResultInfo={};
groupMap.forEach((data,key)=>{
	const first=data.at(0);
	const last=data.at(-1);
	if(!first||!last)
		return;
	if(!resultInfo[first.name]){
		resultInfo[first.name]=[];
	}
	if(!resultInfo[last.name]){
		resultInfo[last.name]=[];
	}
	if(first.name===last.name){
		resultInfo[first.name].push({
			ratingFull:`${first.rating}${first.ratingPlus?'+':''}`,
			ratingClass:RATING_CLASS_MAP[first.ratingClass],
			notes:first.notes,
			min:true,
			max:true
		});
	}
	else{
		resultInfo[first.name].push({
			ratingFull:`${first.rating}${first.ratingPlus?'+':''}`,
			ratingClass:RATING_CLASS_MAP[first.ratingClass],
			notes:first.notes,
			min:true,
		});
		resultInfo[last.name].push({
			ratingFull:`${last.rating}${last.ratingPlus?'+':''}`,
			ratingClass:RATING_CLASS_MAP[last.ratingClass],
			notes:last.notes,
			max:true,
		});
	}
});
console.log(resultInfo);
