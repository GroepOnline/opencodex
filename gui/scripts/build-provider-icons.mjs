#!/usr/bin/env node
/** Rebuild all new provider icons from pinned upstream vector marks. No runtime CDN. */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../public/provider-icons");
export const SOURCE_REVISIONS = {
  "lobehub": "e371fcc0b6d5498b189a3fb935f0eb8ca4c33b74",
  "simpleicons": "90646e4bf7f3b89df6c37e65baf3e7bc759a517c"
};
export const BRAND_SOURCES = [
  [
    "workersai-color.svg",
    "lobehub",
    "workersai-color.svg",
    "Cloudflare Workers AI"
  ],
  [
    "gmicloud-mono.svg",
    "lobehub",
    "gmicloud.svg",
    "GMI Cloud"
  ],
  [
    "cohere-color.svg",
    "lobehub",
    "cohere-color.svg",
    "Cohere"
  ],
  [
    "meta-color.svg",
    "lobehub",
    "meta-color.svg",
    "Meta"
  ],
  [
    "google-color.svg",
    "lobehub",
    "google-color.svg",
    "Google"
  ],
  [
    "googlecloud-color.svg",
    "lobehub",
    "googlecloud-color.svg",
    "Google Cloud"
  ],
  [
    "cerebras-color.svg",
    "lobehub",
    "cerebras-color.svg",
    "Cerebras"
  ],
  [
    "venice-color.svg",
    "lobehub",
    "venice-color.svg",
    "Venice"
  ],
  [
    "zai-mono.svg",
    "lobehub",
    "zai.svg",
    "Z.ai"
  ],
  [
    "xiaomimimo-mono.svg",
    "lobehub",
    "xiaomimimo.svg",
    "Xiaomi MiMo"
  ],
  [
    "neon-mono.svg",
    "simpleicons",
    "neon.svg",
    "Neon"
  ],
  [
    "modal-mono.svg",
    "simpleicons",
    "modal.svg",
    "Modal"
  ],
  [
    "vultr-mono.svg",
    "simpleicons",
    "vultr.svg",
    "Vultr"
  ],
  [
    "ovhcloud-mono.svg",
    "simpleicons",
    "ovh.svg",
    "OVHcloud"
  ]
];
export const ORIGINAL_SYMBOLS = [
  [
    "entrim-symbol.svg",
    "Entrim",
    "<g fill=\"none\" stroke=\"#818CF8\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18 5H6v14h12\"/><path d=\"M6 12h9\"/></g>"
  ],
  [
    "upstage-symbol.svg",
    "Upstage",
    "<g fill=\"none\" stroke=\"#FF874B\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 5v9a7 7 0 0 0 14 0V5\"/><path d=\"m13 5 3-3 3 3\"/></g>"
  ],
  [
    "tokenrouter-symbol.svg",
    "TokenRouter",
    "<g fill=\"none\" stroke=\"#51C7AE\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m6 7 6 5 6-5M12 12v7\"/><circle cx=\"6\" cy=\"6\" r=\"2.2\" fill=\"#51C7AE\" stroke=\"none\"/><circle cx=\"18\" cy=\"6\" r=\"2.2\" fill=\"#51C7AE\" stroke=\"none\"/><circle cx=\"12\" cy=\"20\" r=\"2.2\" fill=\"#51C7AE\" stroke=\"none\"/><circle cx=\"12\" cy=\"12\" r=\"2.3\" fill=\"#133D35\" stroke=\"#51C7AE\"/></g>"
  ],
  [
    "unlooseai-symbol.svg",
    "UnlooseAI",
    "<g fill=\"none\" stroke=\"#E6B869\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M7.1 9.5C4.5 6.8 2 10 2 12s2.5 5.2 5.1 2.5l9.8-9.8C19.5 3 22 6.2 22 8.2s-2.5 5.2-5.1 2.5\"/><path d=\"m16.2 18.2 2 2 3.2-3.2\"/></g>"
  ],
  [
    "parallel-symbol.svg",
    "Parallel",
    "<g fill=\"none\" stroke=\"#8DA8FF\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4.5 19 11 5M12.5 19 19 5\"/><path d=\"M7 19h3M15 5h3\"/></g>"
  ],
  [
    "lm7-symbol.svg",
    "LM7",
    "<g fill=\"none\" stroke=\"#FFBD5D\" stroke-width=\"2.3\" stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M4.5 5v14h7\"/><path d=\"M13 5h7l-5.2 14\"/></g>"
  ]
];
export function frameSvg(raw,title){
 const input=raw.trim(), opening=input.match(/^<svg\b[^>]*>/i);
 if(!opening)throw Error("Missing SVG root: "+title);
 const vb=opening[0].match(/\bviewBox="([^"]+)"/);
 if(!vb)throw Error("Missing SVG viewBox: "+title);
 const inner=input.slice(opening[0].length,input.lastIndexOf("</svg>")).replace(/<title\b[^>]*>[\s\S]*?<\/title>/g,"").trim();
 if(/<(?:script|image|foreignObject|iframe|use|style|text)\b|<!(?:DOCTYPE|ENTITY)|\bon[a-z]+\s*=|\b(?:href|src)\s*=|data:/i.test(inner))throw Error("Unsafe or non-vector icon "+title);
 return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" role="img">\n  <title>'+title.replaceAll("&","&amp;")+'</title>\n  <svg x="1" y="1" width="22" height="22" viewBox="'+vb[1]+'" preserveAspectRatio="xMidYMid meet">\n    '+inner+'\n  </svg>\n</svg>\n';
}
export function checkAsset(svg,file){
 if(!svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" role="img">'))throw Error("Invalid icon frame "+file);
 if(!svg.includes('<svg x="1" y="1" width="22" height="22"'))throw Error("Missing safe area "+file);
 if(!svg.includes("<title>")||!svg.trimEnd().endsWith("</svg>"))throw Error("Invalid SVG markup "+file);
 if(/<(?:script|image|foreignObject|iframe|use|style|text)\b|<!(?:DOCTYPE|ENTITY)|\bon[a-z]+\s*=|\b(?:href|src)\s*=/i.test(svg))throw Error("Unsafe icon content "+file);
}
async function run(){
 const write=process.argv.includes("--write"),verify=process.argv.includes("--verify");
 if(write===verify)throw Error("Specify exactly one of --write or --verify");
 let total=0;
 for(const [file,source,upstream,title] of BRAND_SOURCES){
  let svg;
  if(write){
   const url=source==="lobehub"?"https://raw.githubusercontent.com/lobehub/lobe-icons/"+SOURCE_REVISIONS.lobehub+"/packages/static-svg/icons/"+upstream:"https://raw.githubusercontent.com/simple-icons/simple-icons/"+SOURCE_REVISIONS.simpleicons+"/icons/"+upstream;
   const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
   if(!response.ok)throw Error(url+" HTTP "+response.status);
   svg=frameSvg(await response.text(),title);
   await writeFile(join(ROOT,file),svg);
  }else svg=await readFile(join(ROOT,file),"utf8");
  checkAsset(svg,file);total++;
 }
 for(const [file,title,body] of ORIGINAL_SYMBOLS){
  const svg=frameSvg('<svg viewBox="0 0 24 24">'+body+'</svg>',title);
  if(write)await writeFile(join(ROOT,file),svg);
  else if(await readFile(join(ROOT,file),"utf8")!==svg)throw Error("Drifted original symbol "+file);
  checkAsset(svg,file);total++;
 }
 console.log("Provider SVG kit: "+total+" icons "+(write?"generated":"verified")+", 24x24, 1px margin");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])run().catch(error=>{console.error(error);process.exitCode=1});
