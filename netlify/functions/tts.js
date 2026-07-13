// ТАЙМЕНЬ · озвучка через ElevenLabs — заглушка до этапа E4.2.
// Фронт проверяет наличие и тихо остаётся на браузерном синтезе.

exports.handler = async () => ({
  statusCode: 501,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ error: 'Красивый голос ещё не подключён — говорю браузерным.' }),
});
