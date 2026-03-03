DOĞRULAMA DOSYALARI (Google / Yandex / Bing / Seznam)

1) Google Search Console (HTML dosya):
- Google sana örn: "google1234567890abcdef.html" dosya adını verir.
- Bu dosyayı /public/ kök dizinine EKLE ve içeriğini Google'ın verdiği gibi yaz.
- Deploy ettikten sonra URL şu olmalı:
  https://DOMAININ/google1234567890abcdef.html

2) Alternatif (Meta tag doğrulama):
- HTML sayfalarına şu placeholder'lar eklendi:
  google-site-verification / yandex-verification / msvalidate.01 / seznam-wmt
- Token'ları, Search Console / Yandex Webmaster / Bing Webmaster / Seznam panelinden alıp
  sayfalardaki content="...TOKEN..." alanlarını değiştir.

Not:
- Pages/Workers deploy sonrası cache temizliği için "Purge Everything" yapman gerekebilir.
