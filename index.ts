import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {sha256} from 'js-sha256';
import util from 'util';
//Some environment varaibles
const DOMAIN='https://arcwiki.mcd.blue/';
const INDEX=`${DOMAIN}index.php?`;
const API=`${DOMAIN}api.php`;
const CACHE_FOLDER='/tmp/jscache';
const RATE_LIMIT=20;
//convert numbered ratingClass to string format
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
				throw new Error(`Failed after ${retries+1} attempts: ${util.inspect(error)}`);
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
			throw new Error(`response.data of ${params.params.title} is incorrect: ${util.inspect(response)}`);
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
			throw new Error(`response of ${params.params.title} is incorrect: ${util.inspect(response)}`);
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
//Create `RATE_LIMIT` tasks, each one trigger another when complete recursively
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
//Wait for all promises to finish
while(TaskQueue.id <TaskQueue.songNames.length||TaskQueue.promises.length>0){
	const first=TaskQueue.promises.shift();
	await first;
}
//Interaction with arcwiki, from login to edit
class ApiInteract{
	private _cookie:string;
	private _csrfToken:string;
	async queryLoginToken():Promise<string>{
		const request=await axios.get(API,{params:{
			action:'query',
			meta:'tokens',
			type:'login',
			format:'json',
		}});
		const loginToken=request.data?.query?.tokens?.logintoken;
		if(!loginToken){
			throw new Error(`Failed to get logintoken: ${util.inspect(request)}`);
		}
		this.cookie=request.headers['set-cookie'].join(';');
		return loginToken;
	}
	async login():Promise<void>{
		const request=await axios.post(API,new URLSearchParams({
			action:'login',
			lgname:'CppHusky@sort-notes',
			lgpassword:process.env.ARCWIKI_PASS_SORT_NOTES,
			lgtoken:await this.queryLoginToken(),
			format:'json',
		}).toString(),{headers:{Cookie:this.cookie}});
		const loginResult=request?.data?.login?.result;
		if(request.data.login.result!=='Success'){
			throw new Error(`Failed to login: ${util.inspect(request)}`);
		}
		this.cookie=request.headers['set-cookie'].join(';');
		return;
	}
	async queryCsrfToken(){
		const request=await axios.get(API,{
			params:{
				action:'query',
				meta:'tokens',
				type:'csrf',
				format:'json',
			},
			headers:{Cookie:this.cookie},
		});
		const csrfToken=request.data?.query?.tokens?.csrftoken;
		if(!csrfToken){
			throw new Error(`Failed to get csrftoken: ${util.inspect(request)}`);
		}
		return this.token=csrfToken;
	}
	async push(json:string){
		const request=await axios.post(API,new URLSearchParams({
			action:'edit',
			title:'用户:CppHusky/extremeValues.json',
			bot:'true',
			text:json,
			token:this.token,
			contentformat:'application/json',
			watchlist:'preferences',
			format:'json',
		}).toString(),{headers:{Cookie:this.cookie}});
		const result=request.data?.edit?.result;
		if(result!=='Success')
			throw new Error(`Failed to edit: ${util.inspect(request)}`);
		return;
	}
	get cookie(){
		return this._cookie;
	}
	set cookie(cookie:string){
		this._cookie=cookie;
	}
	get token(){
		return this._csrfToken;
	}
	set token(token:string){
		this._csrfToken=token;
	}
}
//Asynchronously login and fetch csrfToken
const apiInteract=new ApiInteract();
const apipromise=apiInteract.login().then(async (_)=>{
	await apiInteract.queryCsrfToken();
});
//The definition of piece of items, will sort then
type SongItem={
	name:string;
	ratingClass:number;
	rating:number;
	ratingPlus?:boolean;
	notes:number|null;
}
//Flatten songInfo to songItem
const songItem:SongItem[]=Object.entries(songInfo).flatMap(([name,arr])=>
	arr.map(({ratingClass,rating,ratingPlus,notes})=>({
		name,ratingClass,rating,ratingPlus,notes
	}))
);
//Sort them ascending by rating and notes
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
//groupMap will group songItems by rating
const groupMap=new Map<string,SongItem[]>();
for(const item of songItem){
	const key=`${item.rating}${item.ratingPlus?'+':''}`;
	if(!groupMap.has(key)){
		groupMap.set(key,[]);
	}
	groupMap.get(key)!.push(item);
}
//extremeValues is a "name to info" record
type ExtremeValues=Record<string,{
	ratingFull:string;
	ratingClass:string;
	notes:number;
	max?:boolean;
	min?:boolean;
}[]>
const extremeValues:ExtremeValues={};
groupMap.forEach((data,key)=>{
	const first=data.at(0);
	const last=data.at(-1);
	if(!first||!last)
		return;
	if(!extremeValues[first.name]){
		extremeValues[first.name]=[];
	}
	if(!extremeValues[last.name]){
		extremeValues[last.name]=[];
	}
	if(first.name===last.name){
		extremeValues[first.name].push({
			ratingFull:`${first.rating}${first.ratingPlus?'+':''}`,
			ratingClass:RATING_CLASS_MAP[first.ratingClass],
			notes:first.notes,
			min:true,
			max:true
		});
	}
	else{
		extremeValues[first.name].push({
			ratingFull:`${first.rating}${first.ratingPlus?'+':''}`,
			ratingClass:RATING_CLASS_MAP[first.ratingClass],
			notes:first.notes,
			min:true,
		});
		extremeValues[last.name].push({
			ratingFull:`${last.rating}${last.ratingPlus?'+':''}`,
			ratingClass:RATING_CLASS_MAP[last.ratingClass],
			notes:last.notes,
			max:true,
		});
	}
});
//After getting csrfToken, push extremeValues to 用户:CppHusky/extremeValues.json
await apipromise;
apiInteract.push(JSON.stringify(extremeValues));
