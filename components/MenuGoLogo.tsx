import type {ImgHTMLAttributes} from 'react';
/** Tone belongs to the containing surface, not the device's preferred theme.
 * Both files have identical alpha and GO geometry. Never use an invert filter. */
export default function MenuGoLogo({tone='light',...props}:Omit<ImgHTMLAttributes<HTMLImageElement>,'src'|'srcSet'> & {tone?:'light'|'dark'}) {
 return <img {...props} src={tone==='dark'?'/media/menugo-on-dark-r17.png':'/media/menugo-transparent-r8.png'}
  width={props.width??560} height={props.height??147} alt={props.alt??'menügo — Yeni Nesil Dijital Menü'}
  data-menugo-tone={tone}/>;
}
