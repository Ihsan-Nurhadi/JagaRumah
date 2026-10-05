import { helpList, pageSchema } from "@/lib/server/mobile-data";
import { parseSearchParams } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const GET=routeHandler("mobile.help.list",async(request,requestId)=>{const p=parseSearchParams(new URL(request.url).searchParams,pageSchema);return ok(await helpList(p),requestId);});
