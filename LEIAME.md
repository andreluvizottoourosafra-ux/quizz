# Quiz ao vivo – Ouro Safra

Quiz no estilo Kahoot para treinamentos. A pergunta aparece no telão e os participantes respondem pelo celular, todos ao mesmo tempo. A entrada é por QR Code e ninguém precisa de login.

- **Telão:** `https://SEU-ENDERECO/`. Abre direto no QR Code. Para controlar o quiz, clique em **🔒 Apresentador** e digite o PIN.
- **Participantes:** `https://SEU-ENDERECO/jogar`. É para onde o QR Code leva, e cada pessoa joga pelo próprio celular.

## Como funciona

1. **Abertura:** o telão mostra o QR Code e, à medida que as pessoas entram, os nomes aparecem na tela.
2. **Cadastro:** o participante informa o nome e a empresa ou filial.
3. **Pergunta:** o telão mostra a pergunta, o cronômetro e o painel **"Respostas ao vivo"**. Cada resposta que chega faz subir no painel o nome, a filial e o tempo de quem respondeu. **Os pontos não aparecem durante a pergunta**, nem no telão nem no celular, para ninguém descobrir a resposta certa.
4. **Resposta:** quando o tempo acaba, ou quando todos já responderam, o telão destaca a alternativa certa e mostra quantas pessoas escolheram cada opção.
5. **Ranking:** aparece o **Top 15**, com os pontos feitos naquela rodada (selo verde, ex.: **+970**) e o total ao lado. A posição de cada um sobe ou desce com animação, com setas ▲▼.
6. **Final:** pódio com os 3 primeiros e, em seguida, do 4º ao 15º. O botão **Resultados (Excel)** baixa o CSV completo, com a resposta, o acerto, os pontos e o tempo de cada pessoa em cada pergunta.

**Pontuação (como no Kahoot):** quem acerta na hora ganha 1000 pontos, e quem acerta no último segundo ganha cerca de 500. Resposta errada ou fora do tempo vale 0. Em caso de empate, fica na frente quem respondeu mais rápido no total.

No celular, o participante vê se acertou, quantos pontos ganhou, quantos acertos seguidos tem e a posição dele no ranking. Se a página for recarregada, ele continua de onde parou.

**Atalhos do telão:** `Espaço` ou `→` avança a etapa e `F` liga ou desliga a tela cheia.

## Editar as perguntas

Edite o arquivo `perguntas.json`:

```json
{
  "pergunta": "Na fórmula NPK, o que representa a letra K?",
  "alternativas": ["Cálcio", "Potássio", "Nitrogênio", "Fósforo"],
  "correta": 1,
  "tempo": 20
}
```

- `alternativas`: de 2 a 4 opções.
- `correta`: **posição** da alternativa certa, começando do 0 (0 = A, 1 = B, 2 = C, 3 = D).
- `tempo`: segundos para responder.

As perguntas que estão no arquivo agora são só exemplos.

## Logo oficial

O logotipo oficial já está em `public/logo.png` (fundo transparente) e aparece no telão e no celular. Para trocar, substitua esse arquivo.

## Publicar na internet (grátis): Render

1. Crie uma conta em https://render.com e envie esta pasta para um repositório no GitHub.
2. No Render, clique em **New → Blueprint**, escolha o repositório e confirme. O arquivo `render.yaml` já traz toda a configuração.
3. Na criação, o Render pede o valor de `HOST_PIN`, que é a senha do telão. **Use 6 ou mais caracteres**, e não deixe `1234`.
4. Abra `https://SEU-APP.onrender.com` no computador ligado ao telão.

> ⚠️ No plano grátis do Render, o app "dorme" depois de 15 minutos sem uso, e o primeiro acesso leva uns 30 a 50 segundos. **Abra o telão alguns minutos antes do treinamento.** E não reinicie o serviço durante o quiz, porque os dados ficam só na memória. Baixe o CSV no final.

Também funciona no **Railway** (https://railway.app): use New Project → Deploy from GitHub. O comando de início é `npm start`.

## Rodar no próprio computador (mesma rede Wi-Fi)

```bash
npm install
HOST_PIN=4321 npm start
```

Descubra o IP do computador (por exemplo, 192.168.0.10) e abra `http://192.168.0.10:3000`. Os celulares precisam estar no mesmo Wi-Fi. Se o QR Code mostrar `localhost`, inicie com `PUBLIC_URL=http://192.168.0.10:3000 npm start`.

## Variáveis de ambiente

| Variável | Padrão | Para que serve |
|---|---|---|
| `HOST_PIN` | `1234` | Senha do telão e do download do CSV. Depois de 5 erros seguidos, o IP fica bloqueado por 1 minuto |
| `MAX_PLAYERS` | `2000` | Limite de participantes cadastrados |
| `PUBLIC_URL` | endereço acessado | Endereço-base do QR Code (o app acrescenta `/jogar`) |
| `QUESTIONS_FILE` | `perguntas.json` | Usar outro arquivo de perguntas |
| `PORT` | `3000` | Porta do servidor |

## Capacidade e testes

Teste de carga com **500 participantes simultâneos e 20 perguntas** (10.000 respostas): nenhuma se perdeu, a pergunta chegou a todos os celulares em menos de 0,2 s e a soma dos pontos na planilha bateu em todas as linhas. O teste foi repetido com o processamento limitado ao do plano gratuito do Render.

O que mais pesa no dia é o **Wi-Fi do local**: um roteador comum não aguenta 500 celulares ao mesmo tempo. Confirme a rede com o local ou oriente o uso do 4G/5G.

## Segurança

- Qualquer pessoa pode **assistir** ao telão, mas só quem digita o PIN consegue controlar o quiz ou baixar os resultados.
- O servidor ignora mensagens malformadas, e uma delas não derruba o quiz.
- Nomes que começam com `=`, `+`, `-` ou `@` saem com um apóstrofo na planilha, para o Excel não executar como fórmula.
