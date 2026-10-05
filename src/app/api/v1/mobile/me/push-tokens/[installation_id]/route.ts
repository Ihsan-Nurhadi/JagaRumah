import { requireMobile } from "@/lib/server/mobile";
import { deletePush } from "@/lib/server/mobile-data";
import { noContent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
type C={params:Promise<{installation_id?:string}>};
export const DELETE=routeHandler("mobile.push-tokens.delete",async(request,requestId,context)=>{const s=await requireMobile(request);const id=(await(context as C).params).installation_id;if(!id) return noContent(requestId);await deletePush(s.customerId,id);return noContent(requestId);});
