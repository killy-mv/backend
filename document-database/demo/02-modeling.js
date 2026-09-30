// Lesson 2: embed or reference? The central design decision in a document database.
// See ../README.md §3.

import { db, run, section, show } from './db.js'

await run(async () => {
  const authors = db.collection('authors')
  const posts = db.collection('posts')
  const comments = db.collection('comments')
  await Promise.all([authors, posts, comments].map((c) => c.drop().catch(() => {})))

  const { insertedId: authorId } = await authors.insertOne({ name: 'Alice', bio: 'Writes about backends' })

  section('1. Embed: data you read together, stored together')
  // Each post carries a copy of the author's name, so rendering a post list
  // is ONE query with no join. That copy is a deliberate duplicate.
  const postDocs = Array.from({ length: 50 }, (_, i) => ({
    title: `Post #${i + 1}`,
    author: { _id: authorId, name: 'Alice' }, // embedded snapshot
    tags: ['mongodb'],
  }))
  await posts.insertMany(postDocs)
  show('one read renders the post', await posts.findOne({}, { projection: { _id: 0 } }))

  section('2. ...and the bill for that duplicate arrives on update')
  // Alice renames herself. In SQL: one UPDATE on one row. Here: her name is
  // in 1 + 50 places, and you (the app) must find and fix all of them.
  await authors.updateOne({ _id: authorId }, { $set: { name: 'Alice Nguyen' } })
  const { modifiedCount } = await posts.updateMany(
    { 'author._id': authorId },
    { $set: { 'author.name': 'Alice Nguyen' } },
  )
  show('documents rewritten for one rename', 1 + modifiedCount)
  // Forget that updateMany and 50 posts show a stale name forever. Nothing
  // warns you: the database doesn't know those copies are related.

  section('3. Reference: data that grows without limit gets its own collection')
  // Comments could be embedded as an array in the post, but a popular post
  // could collect 100,000 of them, and one document is capped at 16MB.
  // So each comment is its own document pointing at its post.
  const post = await posts.findOne({ title: 'Post #1' })
  await comments.insertMany([
    { postId: post._id, text: 'Great post!', at: new Date() },
    { postId: post._id, text: 'Thanks for the examples.', at: new Date() },
  ])

  // Reading them back together means a join. In MongoDB that's $lookup.
  const [withComments] = await posts
    .aggregate([
      { $match: { _id: post._id } },
      { $lookup: { from: 'comments', localField: '_id', foreignField: 'postId', as: 'comments' } },
      { $project: { _id: 0, title: 1, 'author.name': 1, 'comments.text': 1 } },
    ])
    .toArray()
  show('post + comments via $lookup', withComments)
  // It works, but if every page needs $lookup you're writing a relational
  // app in a document database. That's the signal to reconsider the model.

  section('4. Not every duplicate is a bug: snapshots')
  // An order must keep the price AT THE TIME OF PURCHASE. Embedding a copy is
  // the correct model here. A reference would silently change past orders
  // whenever a product's price changes.
  show('order with embedded snapshot', {
    customer: 'Alice',
    items: [{ sku: 'MUG-1', name: 'Cozy Mug', price: 12.5, qty: 2 }],
    total: 25,
  })
})
