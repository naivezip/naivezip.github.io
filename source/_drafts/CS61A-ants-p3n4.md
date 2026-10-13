---
title: CS61A ants p3n4
date: 2026-03-26 12:06:17
categories: 
  - CS61A
tags: 
  - class
---

## 类的使用以及对象隐喻

----------------------

### 对象隐喻
CS61A中提到[对象隐喻](https://composingprograms.netlify.app/2/4#_2-4-1-%E5%AF%B9%E8%B1%A1%E9%9A%90%E5%96%BB),实际上是一种黑盒思想，在对对象进行操作的时候，要把对象当作一个黑盒，不用去关心里面的属性是如何实现的。

### 类的编写

编写一个类，实现其属性和方法的时候，是将整个类当作函数去编写的，但是与函数不同的是，类里面的方法和类本身不是级联关系，即方法的父帧不是类所属的帧，而是存在于类的全局环境中

例如:

```python
class ThrowerAnt(Ant):
    """ThrowerAnt throws a leaf each turn at the nearest Bee in its range."""

    name = 'Thrower'
    implemented = True
    damage = 1
    # ADD/OVERRIDE CLASS ATTRIBUTES HERE
    upper_bound = float('inf')
    lower_bound = 0
    food_cost = 3
    def nearest_bee(self) -> Bee | None:
        """Return a random Bee from the nearest Place (excluding the Hive) that contains Bees and is reachable from
        the ThrowerAnt's Place by following entrances.
D
        This method returns None if there is no such Bee (or none in range).
        """
        distance = 0
        if not self.place:
            return None  # An Ant that is not in a Place has no nearest Bee
        # BEGIN Problem 3 and 4
        new_place = self.place
        while not new_place.is_hive: 
            if self.lower_bound <= distance <= self.upper_bound:
                if new_place.bees:
                    return random_bee(new_place.bees)
            new_place = new_place.entrance
            distance += 1
        return None
        # END Problem 3 and 4
```

---

这里的```distance```变量必须存在于```nearest_bee```方法中，如果```distance```作为类属性，那么在实例调用```nearest_bee```方法的时候就会搜索不到```distance```的值，就会产生```NameError```

#### 类的全局环境

Python的变量查找遵循[LEGB原则](https://composingprograms.netlify.app/1/3#_1-3-1-%E7%8E%AF%E5%A2%83)，当类创建的时候，其在全局帧（global frame）会绑定一个名称，这个类的方法却在一个局部帧（local frame）中,这个局部帧的父帧是全局帧，即方法的调用/执行遵守的是LEGB原则

#### 对象的继承（MRO）

对类的查找并不在LEGB链中，而是遵守另一套规则**MRO(Method Resolution Order)**,与LEGB链类似的是，在当前类中没找到的属性，Python会自动向父类（base class）查找,需要注意的是，MRO规则和帧没有关系，这里也就说明了为什么```distance```不能作为类属性存在而是要在```nearest_bee```方法中了

