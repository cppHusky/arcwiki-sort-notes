import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {sha256} from 'js-sha256';
const DOMAIN='https://arcwiki.mcd.blue/';
const INDEX=`${DOMAIN}index.php?`;
const API=`${DOMAIN}api.php`;
const CACHE_FOLDER='/tmp/jscache';
class SongInfo{
	name:string;
	ratingClass:number;
	rating:number;
	ratingPlus?:boolean=false;
	notes:number|null=null;
}
const songInfo:SongInfo[]=[];
if(!fs.existsSync(CACHE_FOLDER)){
	await fs.promises.mkdir(CACHE_FOLDER,{recursive:true});
	console.log(`Created directory ${CACHE_FOLDER}`);
}
async function fetchWithRetry(fn:()=>Promise<string>,retries=2):Promise<string>{
	let lastError:any;
	for(let attempt=0;attempt<=retries+1;attempt++){
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
async function domainFetch(prefix,params):Promise<JSON>{
	const sha=sha256.create().update(JSON.stringify([prefix,params])).hex();
	const filename=path.join(CACHE_FOLDER,sha);
	if(fs.existsSync(filename)){
		const stat=await fs.promises.stat(filename);
		if(stat.size>0){
			let contents:string=await fs.promises.readFile(filename,{encoding:'utf8'});
			return Promise.resolve(JSON.parse(contents));
		}
	}
	console.log(`Lack of ${params.params.title} in ${CACHE_FOLDER}, fetching...`);
	const contents:string=await fetchWithRetry(async()=>{
		const response=await axios.get(prefix,params);
		if(typeof response.data==='object'){
			return JSON.stringify(response.data);
		}else{
			throw new Error(`response.data parsing failed: ${response}`);
		};
	});
	fs.writeFile(filename,JSON.stringify(contents),'utf8',(err)=>{
		if(err)
			throw err;
		console.log(`${filename} cached.`);
	});
	return Promise.resolve(JSON.parse(contents));
}
const [songlist,transition]=await Promise.all([
	domainFetch(INDEX,{params:{
		title:'Template:Songlist.json',
		action:'raw',
	}}),
	domainFetch(INDEX,{params:{
		title:'Template:Transition.json',
		action:'raw',
	}}),
]);
songlist['songs']?.forEach((song)=>{
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
	if(name==='Last'){
		return;
	}
	if(song.difficulties){
		song.difficulties.forEach((diff)=>{
			if(typeof diff.ratingClass!=='number'||typeof diff.rating!=='number'){
				console.error(`Warning: ${song.id} have no valid difficuilty`);
				return;
			}
			if(diff.ratingPlus){
				songInfo.push({name:name,ratingClass:diff.ratingClass,rating:diff.rating,ratingPlus:diff.ratingPlus,notes:null});
			}else{
				songInfo.push({name:name,ratingClass:diff.ratingClass,rating:diff.rating,notes:null});
			}
		});
	}else{
		console.error(`Warning: ${song.id} have no valid difficulies`);
	}
});
songInfo.push(
	{name:'Last',ratingClass:0,rating:4,notes:680},
	{name:'Last',ratingClass:1,rating:7,notes:781},
	{name:'Last',ratingClass:2,rating:9,notes:831},
	{name:'Last',ratingClass:3,rating:9,notes:888},
	{name:'Last',ratingClass:3,rating:9,ratingPlus:true,notes:790},
);
