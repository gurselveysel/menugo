import {CampaignStudio} from '@/components/CampaignStudio';
import './campaign.css';
export const dynamic='force-dynamic';
export const metadata={title:'Kampanya Görsel Stüdyosu'};
// UI holds no private data; every data/export endpoint verifies session and manager role.
export default function CampaignPage(){return <CampaignStudio/>;}
