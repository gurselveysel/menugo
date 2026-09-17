import {legacy} from '@/lib/legacy';export const dynamic='force-dynamic';export const runtime='nodejs';export async function GET(){return legacy('platform');}
