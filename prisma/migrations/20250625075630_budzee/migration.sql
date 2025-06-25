-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'GAME_ENTRY', 'GAME_WINNING', 'REFUND');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('LUDO');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('WAITING', 'PLAYING', 'FINISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "avatar" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "razorpaySignature" TEXT,
    "gameId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "type" "GameType" NOT NULL DEFAULT 'LUDO',
    "maxPlayers" INTEGER NOT NULL,
    "entryFee" DECIMAL(10,2) NOT NULL,
    "prizePool" DECIMAL(10,2) NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'WAITING',
    "currentTurn" INTEGER NOT NULL DEFAULT 0,
    "gameData" JSONB,
    "winner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_participations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matchmaking_queues" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameType" "GameType" NOT NULL DEFAULT 'LUDO',
    "maxPlayers" INTEGER NOT NULL,
    "entryFee" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matchmaking_queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_verifications" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "game_participations_userId_gameId_key" ON "game_participations"("userId", "gameId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_participations" ADD CONSTRAINT "game_participations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_participations" ADD CONSTRAINT "game_participations_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matchmaking_queues" ADD CONSTRAINT "matchmaking_queues_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
