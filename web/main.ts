import { renderList } from './list.ts';
import { renderViewer } from './viewer.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app is missing');

if (location.pathname === '/view') {
    renderViewer(app, new URLSearchParams(location.search)).catch(
        (error: unknown) => {
            console.error(error);
            const message = document.createElement('p');
            message.className = 'banner';
            message.setAttribute('role', 'alert');
            message.textContent =
                'PDF を表示できませんでした。時間をおいて開き直してください。解決しない場合は、サーバの管理者に連絡してください。';
            app.prepend(message);
        },
    );
} else {
    renderList(app);
}
