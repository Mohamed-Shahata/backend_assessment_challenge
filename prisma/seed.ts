import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { config } from 'dotenv';
config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const products = [
  { name: 'Wireless Earbuds Pro', price: '49.99' },
  { name: 'Smart Watch X1', price: '129.99' },
  { name: '4K Action Camera', price: '89.50' },
  { name: 'Portable Power Bank 20000mAh', price: '19.99' },
  { name: 'Mechanical Keyboard RGB', price: '59.99' },
];

async function main() {
  console.log('Seeding products...');

  for (const p of products) {
    const product = await prisma.product.create({ data: p });
    console.log(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `  created: ${product.id}  ${product.name}  ($${product.price})`,
    );
  }

  console.log(`Done. Seeded ${products.length} products.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
