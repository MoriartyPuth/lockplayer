import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

const GAP = 24;

// Replacement for GNOME's UnlockDialogLayout that stacks the notifications
// right under the clock column (and so under the now-playing card and its
// lyrics) instead of pinning them to the bottom of the screen. The switch-user
// button keeps its bottom corner.
//
// The clock and the password prompt share a Shell.Stack that is as tall as
// the taller page (the prompt), so the notifications follow the clock's own
// height while the clock shows, and slide down under the prompt as the
// dialog's transition adjustment goes to 1.
export const ColumnLayout = GObject.registerClass(
class LockplayerColumnLayout extends Clutter.LayoutManager {
    constructor(dialog) {
        super();
        this._dialog = dialog;
    }

    vfunc_get_preferred_width(_container, forHeight) {
        return this._dialog._stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(_container, forWidth) {
        return this._dialog._stack.get_preferred_height(forWidth);
    }

    vfunc_allocate(_container, box) {
        const {_stack: stack, _clock: clock, _notificationsBox: notifications} = this._dialog;
        const [width, height] = box.get_size();
        const [, , stackWidth, stackHeight] = stack.get_preferred_size();
        const [, , notificationsWidth, notificationsHeight] = notifications.get_preferred_size();
        const columnWidth = Math.max(stackWidth, notificationsWidth);
        const x1 = Math.floor((width - columnWidth) / 2);
        const margin = height / 10;

        const [, clockHeight] = clock.get_preferred_height(columnWidth);
        const progress = this._dialog._adjustment?.value ?? 0;
        const contentHeight = clockHeight + (stackHeight - clockHeight) * progress;

        const notificationsShown = notificationsHeight > 0 ? GAP + notificationsHeight : 0;
        const stackY = Math.max(margin / 2,
            Math.min(height / 3, height - margin - contentHeight - notificationsShown));

        const actorBox = new Clutter.ActorBox({x1, x2: x1 + columnWidth, y1: stackY, y2: stackY + stackHeight});
        stack.allocate(actorBox);

        // Whatever room is left under the column; the notifications box
        // scrolls when it has more than that.
        const notificationsY = stackY + contentHeight + GAP;
        actorBox.y1 = notificationsY;
        actorBox.y2 = notificationsY + Math.max(0, Math.min(notificationsHeight, height - margin / 2 - notificationsY));
        notifications.allocate(actorBox);

        const switchUser = this._dialog._otherUserButton;
        if (switchUser?.visible) {
            const [, , natWidth, natHeight] = switchUser.get_preferred_size();
            const rtl = switchUser.get_text_direction() === Clutter.TextDirection.RTL;
            actorBox.x1 = rtl ? box.x1 + natWidth : box.x2 - natWidth * 2;
            actorBox.y1 = box.y2 - natHeight * 2;
            actorBox.x2 = actorBox.x1 + natWidth;
            actorBox.y2 = actorBox.y1 + natHeight;
            switchUser.allocate(actorBox);
        }
    }
});
