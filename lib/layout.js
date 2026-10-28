import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

const GAP = 24;

// Replacement for GNOME's UnlockDialogLayout that stacks the notifications
// right under the clock column (and so under the now-playing card) instead
// of pinning them to the bottom of the screen. The switch-user button keeps
// its bottom corner. The column starts a third of the way down, moving up
// only as far as needed to fit.
export const ColumnLayout = GObject.registerClass(
class LockplayerColumnLayout extends Clutter.LayoutManager {
    constructor(stack, notifications, switchUserButton) {
        super();
        this._stack = stack;
        this._notifications = notifications;
        this._switchUserButton = switchUserButton;
    }

    vfunc_get_preferred_width(_container, forHeight) {
        return this._stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(_container, forWidth) {
        return this._stack.get_preferred_height(forWidth);
    }

    vfunc_allocate(_container, box) {
        const [width, height] = box.get_size();
        const [, , stackWidth, stackHeight] = this._stack.get_preferred_size();
        const [, , notificationsWidth, notificationsHeight] = this._notifications.get_preferred_size();
        const columnWidth = Math.max(stackWidth, notificationsWidth);
        const x1 = Math.floor((width - columnWidth) / 2);
        const margin = height / 10;

        const notificationsShown = notificationsHeight > 0 ? GAP + notificationsHeight : 0;
        const stackY = Math.max(margin / 2,
            Math.min(height / 3, height - margin - stackHeight - notificationsShown));

        const actorBox = new Clutter.ActorBox({x1, x2: x1 + columnWidth, y1: stackY, y2: stackY + stackHeight});
        this._stack.allocate(actorBox);

        // Whatever room is left under the column; the notifications box
        // scrolls when it has more than that.
        const notificationsY = stackY + stackHeight + GAP;
        actorBox.y1 = notificationsY;
        actorBox.y2 = notificationsY + Math.max(0, Math.min(notificationsHeight, height - margin / 2 - notificationsY));
        this._notifications.allocate(actorBox);

        if (this._switchUserButton?.visible) {
            const [, , natWidth, natHeight] = this._switchUserButton.get_preferred_size();
            const rtl = this._switchUserButton.get_text_direction() === Clutter.TextDirection.RTL;
            actorBox.x1 = rtl ? box.x1 + natWidth : box.x2 - natWidth * 2;
            actorBox.y1 = box.y2 - natHeight * 2;
            actorBox.x2 = actorBox.x1 + natWidth;
            actorBox.y2 = actorBox.y1 + natHeight;
            this._switchUserButton.allocate(actorBox);
        }
    }
});
