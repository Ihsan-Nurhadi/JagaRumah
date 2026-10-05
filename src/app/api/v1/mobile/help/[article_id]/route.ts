import { helpDetail } from "@/lib/server/mobile-data";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
type C={params:Promise<{article_id?:string}>};
export const GET=routeHandler("mobile.help.detail",async(_request,requestId,context)=>ok(await helpDetail(requireUuid((await(context as C).params).article_id,"article_id")),requestId));
