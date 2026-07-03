// RefLightbox — a plain image pop-up for Plan-view reference thumbnails (product/model/layout
// refs). These aren't generated slots, so the full DetailDrawer (regenerate/archive/revise rail)
// doesn't apply — this is the equivalent "open the image" moment for a reference: one large
// image, a small caption, Esc/backdrop to close. No new tab, no navigation.
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import s from './RefLightbox.module.css';

export interface RefLightboxTarget {
  url: string;
  label: string;
  name: string;
}

export function RefLightbox({
  target,
  onClose,
}: {
  target: RefLightboxTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={!!target} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <Dialog.Title className={s.srOnly}>{target?.label ?? 'Reference image'}</Dialog.Title>
          <Dialog.Close className={s.close} aria-label="Close">
            <Icon name="x" size={16} />
          </Dialog.Close>
          {target ? (
            <>
              <img className={s.img} src={target.url} alt={target.label} />
              <p className={s.caption}>{target.label} · {target.name}</p>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
