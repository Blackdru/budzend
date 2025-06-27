// Clear matchmaking queue script
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearQueue() {
  try {
    console.log('🧹 Clearing matchmaking queue...');
    
    const deleted = await prisma.matchmakingQueue.deleteMany({});
    console.log(`✅ Deleted ${deleted.count} queue entries`);
    
    console.log('🔍 Checking remaining entries...');
    const remaining = await prisma.matchmakingQueue.findMany({});
    console.log(`📊 Remaining entries: ${remaining.length}`);
    
    await prisma.$disconnect();
    console.log('✅ Queue cleared successfully!');
  } catch (error) {
    console.error('❌ Error clearing queue:', error);
    await prisma.$disconnect();
  }
}

clearQueue();