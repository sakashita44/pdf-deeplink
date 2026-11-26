export function showBanner(banner: HTMLElement, message: string): void {
    const text = document.createElement('p');
    text.textContent = message;
    openBanner(banner, [text]);
}

export function openBanner(banner: HTMLElement, content: HTMLElement[]): void {
    const body = document.createElement('div');
    body.className = 'banner-body';
    body.append(...content);
    const close = button('×', () => {
        banner.hidden = true;
    });
    close.className = 'banner-close';
    close.setAttribute('aria-label', '閉じる');
    banner.replaceChildren(body, close);
    banner.hidden = false;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
}

export function toast(element: HTMLElement, message: string): void {
    element.textContent = message;
    element.classList.add('visible');
    window.setTimeout(() => element.classList.remove('visible'), 2000);
}

export async function copy(
    toastElement: HTMLElement,
    text: string,
    done: string,
): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        toast(toastElement, done);
    } catch {
        window.prompt(
            'クリップボードにコピーできませんでした。表示されている内容を手動でコピーしてください。',
            text,
        );
    }
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
